/* ============================================================
   DataGuard — app.js
   Data Redundancy Removal System
   ============================================================ */

'use strict';

// ──────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────
const state = {
  db: [],         // array of record objects
  log: [],        // audit log entries
  blockedCount: 0,
  pendingRecord: null,  // record awaiting force-add decision
  filter: 'all',
  searchQuery: ''
};

// Seed sample data
const seedData = [
  { id: uid(), name: 'Arjun Sharma',   email: 'arjun@example.com',   phone: '+91-9876543210', category: 'Customer', notes: 'Seed record', added: timestamp() },
  { id: uid(), name: 'Priya Menon',    email: 'priya.menon@corp.in',  phone: '+91-9123456780', category: 'Employee', notes: '',            added: timestamp() },
  { id: uid(), name: 'Rahul Gupta',    email: 'rahul.g@vendor.net',   phone: '+91-9988776655', category: 'Vendor',   notes: '',            added: timestamp() },
  { id: uid(), name: 'Sneha Pillai',   email: 'sneha@partner.io',     phone: '+91-8877665544', category: 'Partner',  notes: '',            added: timestamp() },
];
seedData.forEach(r => state.db.push(r));

// ──────────────────────────────────────────────────
// UTILITIES
// ──────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}
function timestamp() {
  const n = new Date();
  return n.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Normalise a string for comparison.
 */
function norm(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Levenshtein distance (for fuzzy name matching).
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/**
 * String similarity: 1 = identical, 0 = totally different.
 * Uses Levenshtein over the longer string.
 */
function stringSim(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Normalise phone: keep only digits.
 */
function normPhone(p) { return (p || '').replace(/\D/g, ''); }

/**
 * Compute field-level similarity between a candidate and an existing record.
 * Returns { name, email, phone, overall }
 */
function computeSimilarity(candidate, existing) {
  const nameSim  = stringSim(candidate.name, existing.name);
  const emailSim = norm(candidate.email) === norm(existing.email) ? 1 : stringSim(candidate.email, existing.email);
  const phoneA   = normPhone(candidate.phone);
  const phoneB   = normPhone(existing.phone);
  const phoneSim = phoneA && phoneB && phoneA === phoneB ? 1 : stringSim(candidate.phone, existing.phone);

  // Weighted composite: email matters most, then name, then phone
  const overall = emailSim * 0.45 + nameSim * 0.35 + phoneSim * 0.20;

  return { name: nameSim, email: emailSim, phone: phoneSim, overall };
}

/**
 * Classify a similarity score.
 */
function classify(score, threshold) {
  const t = threshold / 100;
  if (score >= t)       return 'DUPLICATE';
  if (score >= t * 0.8) return 'SUSPICIOUS';
  return 'UNIQUE';
}

// ──────────────────────────────────────────────────
// DOM REFS
// ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fName     = $('f-name');
const fEmail    = $('f-email');
const fPhone    = $('f-phone');
const fCat      = $('f-category');
const fNotes    = $('f-notes');
const threshold = $('threshold');
const threshVal = $('threshold-val');

const btnValidate = $('btn-validate');
const resultBubble = $('result-bubble');
const rbIcon    = $('rb-icon');
const rbTitle   = $('rb-title');
const rbMsg     = $('rb-msg');
const matchDetails = $('match-details');
const mdBars    = $('md-bars');

const dbTbody   = $('db-tbody');
const emptyRow  = $('empty-row');
const searchDb  = $('search-db');
const btnClear  = $('btn-clear-db');

const logList   = $('log-list');
const btnExport = $('btn-export');

const toast         = $('toast');
const modalOverlay  = $('modal-overlay');
const modalTitle    = $('modal-title');
const modalMsg      = $('modal-msg');
const modalMatches  = $('modal-matches');
const btnCancel     = $('modal-cancel');
const btnForce      = $('modal-force');

const hStatTotal  = $('hstat-total');
const hStatDupes  = $('hstat-dupes');
const hStatAcc    = $('hstat-accuracy');

// ──────────────────────────────────────────────────
// RENDER FUNCTIONS
// ──────────────────────────────────────────────────
function renderTable() {
  const rows = state.db.filter(r => {
    const q = state.searchQuery;
    if (q && !`${r.name} ${r.email} ${r.phone} ${r.category}`.toLowerCase().includes(q)) return false;
    if (state.filter !== 'all' && r.category !== state.filter) return false;
    return true;
  });

  // Clear existing data rows (keep empty-row)
  [...dbTbody.querySelectorAll('tr:not(#empty-row)')].forEach(r => r.remove());

  if (rows.length === 0) {
    emptyRow.classList.remove('hidden');
    return;
  }
  emptyRow.classList.add('hidden');

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escHtml(r.name) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${escHtml(r.email) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${escHtml(r.phone) || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td><span class="cat-badge cat-${escHtml(r.category)}">${escHtml(r.category) || '—'}</span></td>
      <td>${r.added}</td>
      <td><button class="btn-delete" data-id="${r.id}" title="Delete">✕</button></td>
    `;
    dbTbody.appendChild(tr);
  });
}

function renderStats() {
  hStatTotal.textContent = state.db.length;
  hStatDupes.textContent = state.blockedCount;
  const total = state.db.length + state.blockedCount;
  const acc = total === 0 ? 100 : Math.round((state.db.length / total) * 100);
  hStatAcc.textContent = acc + '%';
  hStatAcc.className = acc >= 90 ? 'green' : acc >= 70 ? '' : '';
  hStatAcc.style.color = acc >= 90 ? 'var(--green)' : acc >= 70 ? 'var(--yellow)' : 'var(--red)';
}

function addLogEntry(type, title, detail) {
  const entry = { type, title, detail, time: timestamp() };
  state.log.unshift(entry);

  // Remove placeholder
  const placeholder = logList.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = `log-item log-${type}`;
  div.innerHTML = `
    <div class="log-dot"></div>
    <div class="log-body">
      <strong>${escHtml(title)}</strong>
      <span>${escHtml(detail)}</span>
    </div>
    <div class="log-time">${entry.time}</div>
  `;
  logList.prepend(div);

  // Keep max 60 items
  const items = logList.querySelectorAll('.log-item');
  if (items.length > 60) items[items.length - 1].remove();
}

function showResultBubble(type, icon, title, msg) {
  resultBubble.className = 'result-bubble ' + type;
  rbIcon.textContent = icon;
  rbTitle.textContent = title;
  rbMsg.textContent = msg;
  resultBubble.classList.remove('hidden');
}

function showMatchBars(matches) {
  // matches: array of { record, similarity }
  if (!matches.length) { matchDetails.classList.add('hidden'); return; }

  const best = matches[0];
  const sim  = best.similarity;

  mdBars.innerHTML = '';

  const fields = [
    { label: 'Name Match',  value: sim.name },
    { label: 'Email Match', value: sim.email },
    { label: 'Phone Match', value: sim.phone },
    { label: 'Overall',     value: sim.overall },
  ];

  fields.forEach(f => {
    const pct = Math.round(f.value * 100);
    const cls = pct >= 75 ? 'bar-red' : pct >= 50 ? 'bar-yellow' : 'bar-green';
    const div = document.createElement('div');
    div.className = 'md-bar-row';
    div.innerHTML = `
      <div class="md-bar-label">${f.label}<span>${pct}%</span></div>
      <div class="md-bar-track">
        <div class="md-bar-fill ${cls}" style="width:${pct}%"></div>
      </div>
    `;
    mdBars.appendChild(div);
  });

  matchDetails.classList.remove('hidden');
}

// ──────────────────────────────────────────────────
// VALIDATION CORE
// ──────────────────────────────────────────────────
function validateRecord(candidate) {
  const t = parseInt(threshold.value);
  const results = [];

  for (const existing of state.db) {
    const sim = computeSimilarity(candidate, existing);
    const status = classify(sim.overall, t);
    if (status !== 'UNIQUE') {
      results.push({ record: existing, similarity: sim, status });
    }
  }

  // Sort by overall desc
  results.sort((a, b) => b.similarity.overall - a.similarity.overall);
  return results;
}

// ──────────────────────────────────────────────────
// ACTIONS
// ──────────────────────────────────────────────────
function addRecord(record, forced = false) {
  record.added = timestamp();
  state.db.push(record);
  renderTable();
  renderStats();

  const label = forced ? 'Force-added (possible duplicate)' : 'Unique record added';
  addLogEntry('success', record.name || record.email || 'Record', `${label} · ID: ${record.id}`);
  showToast(forced ? '⚠ Force-added to database.' : '✓ Record added to database.');

  showResultBubble(
    'success', '✓',
    forced ? 'Force-Added' : 'Record Accepted',
    forced
      ? 'Entry added despite similarity warning.'
      : 'Validation passed. Entry appended to cloud database.'
  );
  matchDetails.classList.add('hidden');

  // Highlight new row briefly
  setTimeout(() => {
    const row = dbTbody.querySelector(`[data-id="${record.id}"]`);
    if (row) row.classList.add('new-row');
  }, 50);

  clearForm();
}

function deleteRecord(id) {
  const idx = state.db.findIndex(r => r.id === id);
  if (idx === -1) return;
  const [removed] = state.db.splice(idx, 1);
  renderTable();
  renderStats();
  addLogEntry('delete', removed.name || removed.email || 'Record', `Removed · ID: ${removed.id}`);
  showToast('Record removed from database.');
}

function clearForm() {
  fName.value = '';
  fEmail.value = '';
  fPhone.value = '';
  fCat.value = '';
  fNotes.value = '';
}

// ──────────────────────────────────────────────────
// MODAL
// ──────────────────────────────────────────────────
function showDuplicateModal(candidate, matches) {
  state.pendingRecord = candidate;

  const best = matches[0];
  const pct  = Math.round(best.similarity.overall * 100);

  modalTitle.textContent = `${matches.length} similar record${matches.length > 1 ? 's' : ''} found`;
  modalMsg.textContent   = `This entry scored ${pct}% similarity with existing data, exceeding your ${threshold.value}% threshold. Adding it may create redundancy.`;

  modalMatches.innerHTML = '';
  matches.slice(0, 3).forEach(m => {
    const score = Math.round(m.similarity.overall * 100);
    const cls   = score >= 90 ? 'score-high' : 'score-mid';
    const div   = document.createElement('div');
    div.className = 'modal-match-item';
    div.innerHTML = `
      <strong>${escHtml(m.record.name)}
        <span class="similarity-score ${cls}">${score}%</span>
      </strong>
      <span>${escHtml(m.record.email)} · ${escHtml(m.record.phone)} · ${escHtml(m.record.category)}</span>
    `;
    modalMatches.appendChild(div);
  });

  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  state.pendingRecord = null;
}

// ──────────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ──────────────────────────────────────────────────
// EXPORT
// ──────────────────────────────────────────────────
function exportLog() {
  if (!state.log.length) { showToast('No log entries to export.'); return; }
  const lines = state.log.map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.title}: ${e.detail}`);
  const blob  = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = 'dataguard-audit-log.txt'; a.click();
  URL.revokeObjectURL(url);
  showToast('Log exported.');
}

// ──────────────────────────────────────────────────
// ESCAPE HTML
// ──────────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ──────────────────────────────────────────────────
// EVENT HANDLERS
// ──────────────────────────────────────────────────

// Threshold slider
threshold.addEventListener('input', () => {
  threshVal.textContent = threshold.value + '%';
});

// Validate & Submit
btnValidate.addEventListener('click', () => {
  const candidate = {
    id:       uid(),
    name:     fName.value.trim(),
    email:    fEmail.value.trim(),
    phone:    fPhone.value.trim(),
    category: fCat.value,
    notes:    fNotes.value.trim(),
  };

  // Basic required field check
  if (!candidate.name && !candidate.email && !candidate.phone) {
    showResultBubble('warning', '⚠', 'Insufficient Data', 'Please provide at least a name, email, or phone number.');
    matchDetails.classList.add('hidden');
    return;
  }

  // Run validation
  const matches = validateRecord(candidate);

  if (matches.length === 0) {
    // Unique record
    addRecord(candidate);
    addLogEntry('success', candidate.name || candidate.email, 'Passed validation — no duplicates found.');
  } else {
    const best    = matches[0];
    const pct     = Math.round(best.similarity.overall * 100);
    const status  = best.status;

    state.blockedCount++;
    renderStats();

    if (status === 'DUPLICATE') {
      showResultBubble(
        'duplicate', '✗',
        'Duplicate Detected',
        `Blocked — ${pct}% similarity with "${best.record.name || best.record.email}". This record appears to already exist.`
      );
      addLogEntry('dupe', candidate.name || candidate.email, `Blocked · ${pct}% match with ID ${best.record.id}`);
      showMatchBars(matches);
      showDuplicateModal(candidate, matches);
    } else {
      // SUSPICIOUS: warn but don't block outright
      showResultBubble(
        'warning', '⚠',
        'Similarity Warning',
        `${pct}% match found with "${best.record.name || best.record.email}". Review before proceeding.`
      );
      addLogEntry('warn', candidate.name || candidate.email, `Suspicious · ${pct}% match with ID ${best.record.id}`);
      showMatchBars(matches);
      showDuplicateModal(candidate, matches);
    }
  }
});

// Delete record
dbTbody.addEventListener('click', e => {
  const btn = e.target.closest('.btn-delete');
  if (btn) deleteRecord(btn.dataset.id);
});

// Clear all
btnClear.addEventListener('click', () => {
  if (!state.db.length) { showToast('Database is already empty.'); return; }
  const n = state.db.length;
  state.db.length = 0;
  renderTable();
  renderStats();
  addLogEntry('system', 'Database cleared', `${n} records removed.`);
  showToast(`Cleared ${n} records.`);
  resultBubble.classList.add('hidden');
  matchDetails.classList.add('hidden');
});

// Search
searchDb.addEventListener('input', () => {
  state.searchQuery = searchDb.value.trim().toLowerCase();
  renderTable();
});

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderTable();
  });
});

// Modal cancel
btnCancel.addEventListener('click', () => {
  closeModal();
  showToast('Entry discarded.');
  addLogEntry('dupe', 'Entry discarded', 'User chose not to force-add the duplicate.');
});

// Modal force-add
btnForce.addEventListener('click', () => {
  const record = state.pendingRecord;
  closeModal();
  if (record) {
    addRecord(record, true);
    addLogEntry('warn', record.name || record.email, 'Force-added despite duplicate warning.');
  }
});

// Export log
btnExport.addEventListener('click', exportLog);

// ──────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────
function init() {
  renderTable();
  renderStats();
  addLogEntry('system', 'DataGuard initialised', `${state.db.length} seed records loaded.`);
}

init();