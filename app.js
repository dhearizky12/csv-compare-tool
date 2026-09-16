'use strict';

/* ---------------------------------------------------------------------
   CSV parsing — RFC4180-ish, auto delimiter, BOM-safe
--------------------------------------------------------------------- */

function stripBOM(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function detectDelimiter(sampleLine) {
  const candidates = [',', ';', '\t', '|'];
  let best = ',', bestCount = -1;
  for (const d of candidates) {
    let count = 0, inQ = false;
    for (let i = 0; i < sampleLine.length; i++) {
      const c = sampleLine[i];
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function parseCSV(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function parseFile(text) {
  const clean = stripBOM(text);
  const firstLineEnd = clean.indexOf('\n');
  const sample = clean.slice(0, firstLineEnd === -1 ? clean.length : firstLineEnd);
  const delimiter = detectDelimiter(sample);
  const rows = parseCSV(clean, delimiter);
  if (rows.length === 0) return { headers: [], data: [], delimiter };
  const rawHeaders = rows[0];
  const headers = rawHeaders.map((h, idx) => {
    const t = h.trim();
    return t === '' ? `Kolom_${idx + 1}` : t;
  });
  const data = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
  return { headers, data, delimiter };
}

/* ---------------------------------------------------------------------
   Key building + comparison engine
--------------------------------------------------------------------- */

const KEY_SEP = '␟'; // unit separator, unlikely to collide with real data

function buildKey(row, cols) {
  return cols.map(c => (row[c] === undefined ? '' : String(row[c]).trim())).join(KEY_SEP);
}

// Duplicate full-row (or full-key) matches still pair up correctly: the
// Nth occurrence of a given key in Old is matched against the Nth
// occurrence of that same key in New, instead of colliding into one slot.
function withOccurrenceKeys(data, cols) {
  const counters = new Map();
  return data.map(r => {
    const base = buildKey(r, cols);
    const n = (counters.get(base) || 0) + 1;
    counters.set(base, n);
    return base + KEY_SEP + '#' + n;
  });
}

function isNumericStr(v) {
  if (v === '' || v === undefined || v === null) return false;
  return !isNaN(v) && !isNaN(parseFloat(v));
}

function valuesEqual(a, b) {
  const as = (a === undefined || a === null) ? '' : String(a).trim();
  const bs = (b === undefined || b === null) ? '' : String(b).trim();
  if (as === bs) return true;
  if (isNumericStr(as) && isNumericStr(bs)) {
    const fa = parseFloat(as), fb = parseFloat(bs);
    return Math.abs(fa - fb) <= Math.max(1e-6, Math.abs(fa) * 1e-9);
  }
  return false;
}

// Greedy escalation: try the first column alone, then the first two, etc,
// in the order given, until the combination is unique inside BOTH datasets.
function autoDetectKey(dataOld, dataNew, headers) {
  for (let k = 1; k <= headers.length; k++) {
    const cols = headers.slice(0, k);
    if (isUniqueWithin(dataOld, cols) && isUniqueWithin(dataNew, cols)) return cols;
  }
  return headers.slice();
}

function isUniqueWithin(data, cols) {
  const seen = new Set();
  for (const r of data) {
    const k = buildKey(r, cols);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

function compare(oldFile, newFile, keyCols) {
  const headers = oldFile.headers.filter(h => newFile.headers.includes(h));
  const extraOld = oldFile.headers.filter(h => !newFile.headers.includes(h));
  const extraNew = newFile.headers.filter(h => !oldFile.headers.includes(h));

  const fullRowMode = keyCols.length >= headers.length;
  const keysOld = withOccurrenceKeys(oldFile.data, keyCols);
  const keysNew = withOccurrenceKeys(newFile.data, keyCols);

  const mapOld = new Map();
  oldFile.data.forEach((r, i) => mapOld.set(keysOld[i], r));
  const mapNew = new Map();
  newFile.data.forEach((r, i) => mapNew.set(keysNew[i], r));

  const allKeys = new Set([...mapOld.keys(), ...mapNew.keys()]);
  const compareCols = fullRowMode ? headers : headers.filter(h => !keyCols.includes(h));

  const results = [];
  let identical = 0, changed = 0, onlyOld = 0, onlyNew = 0;

  for (const key of allKeys) {
    const rOld = mapOld.get(key);
    const rNew = mapNew.get(key);
    const plainKey = key.split(KEY_SEP).slice(0, keyCols.length).join(' | ');
    if (rOld && !rNew) {
      onlyOld++;
      results.push({ status: 'ONLY_OLD', key: plainKey, changedCols: [], old: rOld, new: null });
    } else if (!rOld && rNew) {
      onlyNew++;
      results.push({ status: 'ONLY_NEW', key: plainKey, changedCols: [], old: null, new: rNew });
    } else {
      const diffCols = compareCols.filter(c => !valuesEqual(rOld[c], rNew[c]));
      if (diffCols.length === 0) {
        identical++;
        results.push({ status: 'SAME', key: plainKey, changedCols: [], old: rOld, new: rNew });
      } else {
        changed++;
        results.push({ status: 'CHANGED', key: plainKey, changedCols: diffCols, old: rOld, new: rNew });
      }
    }
  }

  return {
    headers, extraOld, extraNew, fullRowMode, keyCols,
    stats: {
      rowsOld: oldFile.data.length, rowsNew: newFile.data.length,
      identical, changed, onlyOld, onlyNew
    },
    results
  };
}

/* ---------------------------------------------------------------------
   CSV export
--------------------------------------------------------------------- */

function csvEscape(v) {
  if (v === undefined || v === null) v = '';
  v = String(v);
  if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

function buildExportCSV(state, rows) {
  const cols = ['Status', 'Key'];
  state.headers.forEach(h => { cols.push('Old_' + h); cols.push('New_' + h); });
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) {
    const line = [statusLabel(r.status), r.key];
    state.headers.forEach(h => {
      line.push(r.old ? r.old[h] : '');
      line.push(r.new ? r.new[h] : '');
    });
    lines.push(line.map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

function statusLabel(s) {
  return { SAME: 'SAMA', CHANGED: 'BERUBAH', ONLY_OLD: 'HANYA_DI_LAMA', ONLY_NEW: 'HANYA_DI_BARU' }[s] || s;
}

function downloadCSV(filename, content) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------------------------------------------------------------
   App state + UI wiring
--------------------------------------------------------------------- */

const state = {
  old: null, new: null,
  keyCols: [],
  result: null,
  filter: 'DIFF', // DIFF | ALL | SAME | CHANGED | ONLY_OLD | ONLY_NEW
  search: '',
  page: 1,
  pageSize: 100,
};

const el = (id) => document.getElementById(id);

function setupDropZone(zoneId, inputId, labelId, side) {
  const zone = el(zoneId), input = el(inputId), label = el(labelId);
  const handleFile = (file) => {
    if (!file) return;
    label.textContent = file.name;
    zone.classList.add('has-file');
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseFile(e.target.result);
      state[side] = parsed;
      zone.querySelector('.dz-meta').textContent =
        `${parsed.data.length.toLocaleString('id-ID')} baris · ${parsed.headers.length} kolom`;
      onFilesReady();
    };
    reader.readAsText(file, 'utf-8');
  };
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => handleFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove('drag');
  }));
  zone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
}

function onFilesReady() {
  if (!state.old || !state.new) return;
  el('config').hidden = false;
  const headers = state.old.headers.filter(h => state.new.headers.includes(h));
  renderKeyChips(headers);
  autoDetect();
  renderStructureWarning();
}

function renderStructureWarning() {
  const extraOld = state.old.headers.filter(h => !state.new.headers.includes(h));
  const extraNew = state.new.headers.filter(h => !state.old.headers.includes(h));
  const box = el('structWarning');
  if (extraOld.length === 0 && extraNew.length === 0) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<strong>Kolom tidak sama persis:</strong> ' +
    (extraOld.length ? `hanya di Lama: ${extraOld.join(', ')}. ` : '') +
    (extraNew.length ? `hanya di Baru: ${extraNew.join(', ')}.` : '') +
    ' Perbandingan memakai kolom yang beririsan saja.';
}

function renderKeyChips(headers) {
  const wrap = el('keyChips');
  wrap.innerHTML = '';
  headers.forEach(h => {
    const id = 'key_' + h.replace(/[^a-z0-9]/gi, '_');
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.innerHTML = `<input type="checkbox" id="${id}" value="${h.replace(/"/g, '&quot;')}"><span>${h}</span>`;
    chip.querySelector('input').addEventListener('change', onKeySelectionChanged);
    wrap.appendChild(chip);
  });
}

function setKeySelection(cols) {
  const wrap = el('keyChips');
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.checked = cols.includes(cb.value);
  });
  onKeySelectionChanged();
}

function onKeySelectionChanged() {
  const wrap = el('keyChips');
  const checked = [...wrap.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
  state.keyCols = checked;
  updateKeyModeNote();
  el('runCompare').disabled = checked.length === 0;
}

function updateKeyModeNote() {
  const headers = state.old.headers.filter(h => state.new.headers.includes(h));
  const note = el('keyModeNote');
  if (state.keyCols.length >= headers.length) {
    note.textContent = 'Mode: gabungan SEMUA kolom sebagai kunci VLOOKUP (persis seperti cara manual di Excel). Baris dianggap beda kalau satu saja kolomnya beda — tidak ada rincian "kolom mana yang berubah".';
  } else {
    note.textContent = `Mode: kunci dari ${state.keyCols.length} kolom terpilih. Baris yang cocok tapi punya kolom lain berbeda akan ditandai BERUBAH, lengkap dengan kolom mana yang beda.`;
  }
}

function autoDetect() {
  const headers = state.old.headers.filter(h => state.new.headers.includes(h));
  const cols = autoDetectKey(state.old.data, state.new.data, headers);
  setKeySelection(cols);
}

el('autoDetectBtn').addEventListener('click', autoDetect);
el('selectAllBtn').addEventListener('click', () => {
  const headers = state.old.headers.filter(h => state.new.headers.includes(h));
  setKeySelection(headers);
});

el('runCompare').addEventListener('click', () => {
  state.result = compare(state.old, state.new, state.keyCols);
  state.page = 1;
  state.filter = 'DIFF';
  renderResults();
});

function renderResults() {
  const r = state.result;
  el('results').hidden = false;
  const s = r.stats;
  el('statOld').textContent = s.rowsOld.toLocaleString('id-ID');
  el('statNew').textContent = s.rowsNew.toLocaleString('id-ID');
  el('statSame').textContent = s.identical.toLocaleString('id-ID');
  el('statChanged').textContent = s.changed.toLocaleString('id-ID');
  el('statOnlyOld').textContent = s.onlyOld.toLocaleString('id-ID');
  el('statOnlyNew').textContent = s.onlyNew.toLocaleString('id-ID');

  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));
  renderTable();
}

document.querySelectorAll('.filter-chip').forEach(c => {
  c.addEventListener('click', () => {
    state.filter = c.dataset.filter;
    state.page = 1;
    document.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x === c));
    renderTable();
  });
});

document.querySelectorAll('.stat-tile').forEach(t => {
  t.addEventListener('click', () => {
    const f = t.dataset.filter;
    if (!f) return;
    state.filter = f; state.page = 1;
    document.querySelectorAll('.filter-chip').forEach(x => x.classList.toggle('active', x.dataset.filter === f));
    renderTable();
  });
});

el('searchBox').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  state.page = 1;
  renderTable();
});

function filteredRows() {
  const r = state.result;
  let rows = r.results;
  if (state.filter === 'DIFF') rows = rows.filter(x => x.status !== 'SAME');
  else if (state.filter !== 'ALL') rows = rows.filter(x => x.status === state.filter);
  if (state.search) {
    rows = rows.filter(x => x.key.toLowerCase().includes(state.search) ||
      x.changedCols.join(' ').toLowerCase().includes(state.search));
  }
  return rows;
}

function renderTable() {
  const r = state.result;
  const rows = filteredRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  el('resultCount').textContent = `${rows.length.toLocaleString('id-ID')} baris`;
  el('pageInfo').textContent = `Halaman ${state.page} / ${totalPages}`;
  el('prevPage').disabled = state.page <= 1;
  el('nextPage').disabled = state.page >= totalPages;

  const cols = r.headers;
  const thead = el('resultTable').querySelector('thead');
  thead.innerHTML = '<tr><th>Status</th><th>Kunci</th>' + cols.map(c => `<th>${escapeHTML(c)}</th>`).join('') + '</tr>';

  const tbody = el('resultTable').querySelector('tbody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  pageRows.forEach(row => {
    const tr = document.createElement('tr');
    tr.className = 'row-' + row.status;
    let cells = `<td><span class="badge badge-${row.status}">${statusLabel(row.status)}</span></td>` +
      `<td class="keycell">${escapeHTML(row.key)}</td>`;
    cols.forEach(c => {
      const changed = row.changedCols.includes(c);
      let content;
      if (row.status === 'ONLY_OLD') content = escapeHTML(row.old[c]);
      else if (row.status === 'ONLY_NEW') content = escapeHTML(row.new[c]);
      else if (changed) content = `<span class="from">${escapeHTML(row.old[c])}</span><span class="arrow">→</span><span class="to">${escapeHTML(row.new[c])}</span>`;
      else content = escapeHTML(row.new ? row.new[c] : row.old[c]);
      cells += `<td class="${changed ? 'cell-changed' : ''}">${content}</td>`;
    });
    tr.innerHTML = cells;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
}

function escapeHTML(v) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

el('prevPage').addEventListener('click', () => { state.page--; renderTable(); });
el('nextPage').addEventListener('click', () => { state.page++; renderTable(); });

el('downloadBtn').addEventListener('click', () => {
  const rows = filteredRows();
  const csv = buildExportCSV(state.result, rows);
  downloadCSV('csv-compare-hasil.csv', csv);
});

setupDropZone('dzOld', 'inputOld', 'labelOld', 'old');
setupDropZone('dzNew', 'inputNew', 'labelNew', 'new');
