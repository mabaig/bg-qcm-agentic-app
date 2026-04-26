/* ─── Markdown renderer ────────────────────────────────────────────────────── */
// Configured once on load; marked is loaded via CDN before this script
function initMarked() {
  if (typeof marked === 'undefined') return;
  marked.setOptions({
    gfm:    true,   // GitHub-flavoured markdown — enables pipe tables
    breaks: true,   // newline → <br>
  });
}
document.addEventListener('DOMContentLoaded', initMarked);

function md(text) {
  if (typeof marked === 'undefined') return esc(text);
  const html = marked.parse(String(text ?? ''));
  return html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
}

/* ─── State ────────────────────────────────────────────────────────────────── */
let sessionId   = null;
let eventSource = null;
let planSteps   = [];
let logCount    = 0;
let stats       = { total: 0, success: 0, failed: 0 };
let tableData   = {};   // toolName → result array, for result tables
let pendingASNPayload = null;
let parsedASNData     = null;  // { parsed, poData, asnPayload } — set after upload, cleared on new session

const ASN_INTENT_RE = /\b(create|submit|send|make|build|generate)?\s*(asn|advanced.?ship|packing.?slip|receipt.?request)\b/i;

/* ─── Review-modal field configs ────────────────────────────────────────────── */
const REVIEW_FIELDS = {
  create_quality_case: [
    { key: 'description',    label: 'Description',      editable: true,  type: 'textarea' },
    { key: 'caseTypeId',     label: 'Case Type ID',     editable: false },
    { key: 'priorityLevel',  label: 'Priority',         editable: true,  type: 'select', options: ['Low','Medium','High'] },
    { key: 'affectedLotLpn', label: 'Affected LPN/Lot', editable: true,  type: 'text' },
    { key: 'facilityCode',   label: 'Facility',         editable: false },
  ],
  lock_inventory: [
    { key: 'targetType',   label: 'Target Type',    editable: false },
    { key: 'targetValue',  label: 'Target Value(s)',editable: false },
    { key: 'caseId',       label: 'Case ID',        editable: false },
    { key: 'reasonCodeId', label: 'Reason Code ID', editable: false },
    { key: 'skuValue',     label: 'SKU',            editable: false },
    { key: 'lockComments', label: 'Lock Comments',  editable: true, type: 'textarea' },
    { key: 'priority',     label: 'Priority',       editable: true, type: 'select', options: ['Low','Medium','High'] },
  ],
};

/* ─── DOM refs ─────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const chatMessages    = $('chat-messages');
const chatInput       = $('chat-input');
const btnSend         = $('btn-send');
const btnNewSession   = $('btn-new-session');
const btnBell         = $('btn-bell');
const btnTheme        = $('btn-theme');
const bellBadge       = $('bell-badge');
const reviewModal     = $('review-modal');
const modalToolBadge  = $('modal-tool-badge');
const modalBody       = $('modal-body');
const btnModalConfirm = $('btn-modal-confirm');
const btnModalCancel  = $('btn-modal-cancel');
const agentBadge      = $('agent-status-badge');
const planContent     = $('plan-content');
const planImpact      = $('plan-impact');
const planStepCount   = $('plan-step-count');
const sectionActions  = $('section-actions');
const actionsContent  = $('actions-content');
const confirmMessage  = $('confirm-message');
const btnConfirm      = $('btn-confirm');
const btnCancel       = $('btn-cancel');
const logsContent     = $('logs-content');
const logCountBadge   = $('log-count');
const resultsContent  = $('results-content');
const panelDot        = document.querySelector('.panel-dot');

/* ─── ASN DOM refs ───────────────────────────────────────────────────────── */
const sectionDoc       = $('section-doc');
const sectionPO        = $('section-po');
const sectionASN       = $('section-asn-review');
const docContent       = $('doc-content');
const poContent        = $('po-content');
const asnReviewContent = $('asn-review-content');

/* ─── SVG icon helpers ───────────────────────────────────────────────────── */
const SVG_SUN  = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
const SVG_MOON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SVG_CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

/* ─── Init ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupCollapsibleSections();
  setupResizeHandle();
  setupMobileTabs();

  chatInput.addEventListener('keydown', onInputKeydown);
  btnSend.addEventListener('click', sendMessage);
  btnNewSession.addEventListener('click', newSession);
  btnConfirm.addEventListener('click', () => sendConfirmation(true));
  btnCancel.addEventListener('click',  () => sendConfirmation(false));
  btnBell.addEventListener('click', onBellClick);
  btnTheme.addEventListener('click', toggleTheme);
  $('btn-signout').addEventListener('click', () => {
    sessionStorage.removeItem('qcm_auth');
    window.location.replace('/login');
  });
  btnModalConfirm.addEventListener('click', () => submitReview(true));
  btnModalCancel.addEventListener('click',  () => submitReview(false));

  $('btn-asn-edit-send')?.addEventListener('click',   sendASNFromEditor);
  $('btn-asn-edit-cancel')?.addEventListener('click', () => {
    $('asn-edit-modal').classList.add('hidden');
  });

  document.querySelectorAll('.example-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.dataset.prompt;
      chatInput.focus();
    });
  });

  setupFileUpload();

  pollOpenCases();
  setInterval(pollOpenCases, 60_000);
});

/* ─── Theme toggle ───────────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (btnTheme) btnTheme.innerHTML = theme === 'light' ? SVG_MOON : SVG_SUN;
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const current = localStorage.getItem('theme') || 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
}

/* ─── Collapsible workspace sections ────────────────────────────────────── */
function setupCollapsibleSections() {
  ['section-plan', 'section-logs', 'section-results',
   'section-doc', 'section-po', 'section-asn-review'].forEach(id => {
    const section = $(id);
    if (!section) return;
    const header = section.querySelector('.section-header');
    if (!header) return;

    const btn = document.createElement('button');
    btn.className = 'section-collapse-btn';
    btn.setAttribute('aria-label', 'Collapse section');
    btn.innerHTML = SVG_CHEVRON;
    header.appendChild(btn);

    btn.addEventListener('click', () => {
      section.classList.toggle('collapsed');
      btn.setAttribute('aria-label',
        section.classList.contains('collapsed') ? 'Expand section' : 'Collapse section');
    });
  });
}

/* ─── Mobile tab navigation ──────────────────────────────────────────────── */
function setupMobileTabs() {
  const tabBar  = document.getElementById('mobile-tab-bar');
  const appBody = document.querySelector('.app-body');
  if (!tabBar || !appBody) return;

  tabBar.querySelectorAll('.mobile-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMobileTab(tab.dataset.tab));
  });
}

function switchMobileTab(tab) {
  const appBody = document.querySelector('.app-body');
  const tabBar  = document.getElementById('mobile-tab-bar');
  if (!appBody || !tabBar) return;
  appBody.dataset.tab = tab;
  tabBar.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

/* ─── Resizable columns ──────────────────────────────────────────────────── */
function setupResizeHandle() {
  const handle   = $('resize-handle');
  const panelChat = document.querySelector('.panel-chat');
  const appBody   = document.querySelector('.app-body');
  if (!handle || !panelChat || !appBody) return;

  let dragging = false;
  let startX, startWidth;

  handle.addEventListener('mousedown', e => {
    dragging  = true;
    startX    = e.clientX;
    startWidth = panelChat.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta    = e.clientX - startX;
    const total    = appBody.offsetWidth;
    const newWidth = Math.min(Math.max(startWidth + delta, 180), total - 360);
    panelChat.style.width    = newWidth + 'px';
    panelChat.style.minWidth = 'unset';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

/* ─── Bell / open-cases polling ─────────────────────────────────────────────── */
async function pollOpenCases() {
  try {
    const res = await fetch('/api/open-cases-count');
    if (!res.ok) return;
    const { count } = await res.json();
    updateBell(count);
  } catch { /* silent — network may be unavailable */ }
}

function updateBell(count) {
  if (count > 0) {
    bellBadge.textContent = count > 99 ? '99+' : String(count);
    bellBadge.classList.remove('hidden');
    btnBell.classList.add('has-alerts');
  } else {
    bellBadge.classList.add('hidden');
    btnBell.classList.remove('has-alerts');
  }
}

function onBellClick() {
  chatInput.value = 'Show me all open quality cases';
  chatInput.focus();
}

/* ─── Keyboard ──────────────────────────────────────────────────────────────── */
function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

/* ─── Send message ──────────────────────────────────────────────────────────── */
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  btnSend.disabled = true;

  removeWelcome();
  addChatMessage('user', text);

  // If ASN intent but no file uploaded yet — prompt the user to attach one
  if (!parsedASNData && ASN_INTENT_RE.test(text)) {
    addChatMessage('assistant',
      'To create an ASN, please attach a packing slip first.\n\nClick the **📎** button in the chat footer to upload a PDF or DOCX packing slip, then I\'ll parse it and walk you through the rest.');
    btnSend.disabled = false;
    return;
  }

  // If a packing slip was uploaded and user is asking to create ASN — show review
  if (parsedASNData && ASN_INTENT_RE.test(text)) {
    const { parsed, poData, asnPayload, fusionBaseUrl, fusionUiBaseUrl } = parsedASNData;
    renderDocSection(parsed);
    renderPOSection(poData, parsed, fusionBaseUrl, fusionUiBaseUrl);
    renderASNReview(parsed, poData, asnPayload);
    switchMobileTab('workspace');
    sectionDoc.scrollIntoView({ behavior: 'smooth', block: 'start' });
    btnSend.disabled = false;
    return;
  }

  clearWorkspace();
  switchMobileTab('workspace');

  // Connect SSE before posting so we don't miss early events
  if (!sessionId) sessionId = crypto.randomUUID();
  connectSSE(sessionId);
  await sleep(150); // allow SSE to connect

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: res.statusText }));
      addChatMessage('system', `Error: ${error}`);
      setStatus('failed');
    }
  } catch (err) {
    addChatMessage('system', `Network error: ${err.message}`);
    setStatus('failed');
    btnSend.disabled = false;
  }
}

/* ─── SSE connection ────────────────────────────────────────────────────────── */
function connectSSE(sid) {
  if (eventSource) { eventSource.close(); eventSource = null; }

  eventSource = new EventSource(`/api/stream/${sid}`);

  eventSource.addEventListener('connected',             () => {});
  eventSource.addEventListener('status',                e => onStatus(JSON.parse(e.data)));
  eventSource.addEventListener('plan',                  e => onPlan(JSON.parse(e.data)));
  eventSource.addEventListener('plan_step_update',      e => onPlanStepUpdate(JSON.parse(e.data)));
  eventSource.addEventListener('confirmation_required', e => onConfirmationRequired(JSON.parse(e.data)));
  eventSource.addEventListener('review_required',       e => onReviewRequired(JSON.parse(e.data)));
  eventSource.addEventListener('step_start',            e => onStepStart(JSON.parse(e.data)));
  eventSource.addEventListener('step_complete',         e => onStepComplete(JSON.parse(e.data)));
  eventSource.addEventListener('step_error',            e => onStepError(JSON.parse(e.data)));
  eventSource.addEventListener('complete',              e => onComplete(JSON.parse(e.data)));
  eventSource.addEventListener('cancelled',             e => onCancelled(JSON.parse(e.data)));
  eventSource.addEventListener('off_topic',             e => onOffTopic(JSON.parse(e.data)));
  eventSource.addEventListener('error',                 e => {
    if (e.data) onAgentError(JSON.parse(e.data));
  });
}

/* ─── Event handlers ────────────────────────────────────────────────────────── */
function onStatus(data) {
  setStatus(data.status);
  if (data.status === 'planning')   addChatMessage('system', '🧠 Generating plan…');
  if (data.status === 'executing')  addChatMessage('system', '⚙️ Executing plan…');
}

function onPlan(data) {
  planSteps = data.steps || [];
  setStatus('planning');

  if (!planSteps.length) {
    planContent.innerHTML = `<div class="empty-state">No structured plan parsed — see chat for details.</div>`;
    return;
  }

  renderPlan();

  if (data.impact) {
    planImpact.innerHTML = `<strong>Impact:</strong> ${esc(data.impact)}`;
    planImpact.classList.remove('hidden');
  }

  planStepCount.textContent = planSteps.length;
}

function onPlanStepUpdate(data) {
  const { index, status } = data;
  if (planSteps[index]) planSteps[index].status = status;
  renderPlan();
}

function onConfirmationRequired(data) {
  setStatus('awaiting');
  confirmMessage.textContent = data.message;
  sectionActions.classList.remove('hidden');
  btnConfirm.disabled = false;
  btnCancel.disabled  = false;
  addChatMessage('assistant', `⚠ Confirmation required:\n${data.message}`);
  switchMobileTab('workspace');
  sectionActions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function onStepStart(data) {
  logCount++;
  logCountBadge.textContent = logCount;
  stats.total++;

  const entry = buildLogEntry(data.stepIndex, data.toolName, 'running', data.payload, null, null);
  logsContent.querySelector('.empty-state')?.remove();
  logsContent.appendChild(entry);
  entry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function onStepComplete(data) {
  stats.success++;
  updateLogEntry(data.id, data.toolName, 'success', data.resultSummary, data.result);
  captureTableData(data.toolName, data.result);
  updateStatsDisplay();
}

function onStepError(data) {
  stats.failed++;
  updateLogEntry(data.id, data.toolName, 'failed', data.error, null);
  updateStatsDisplay();
}

function onComplete(data) {
  setStatus('complete');
  btnSend.disabled = false;
  sectionActions.classList.add('hidden');

  addChatMessage('assistant', data.summary || data.message || 'Done.');
  renderResults(data);
  eventSource?.close();
  switchMobileTab('chat');
}

function onCancelled(data) {
  setStatus('cancelled');
  btnSend.disabled = false;
  sectionActions.classList.add('hidden');
  addChatMessage('system', `✕ ${data.message}`);
  eventSource?.close();
  switchMobileTab('chat');
}

function onOffTopic(data) {
  setStatus('idle');
  btnSend.disabled = false;
  addChatMessage('assistant', data.message || 'I can only help with QCM and Oracle WMS Cloud operations.');
  eventSource?.close();
  switchMobileTab('chat');
}

function onAgentError(data) {
  setStatus('failed');
  btnSend.disabled = false;
  addChatMessage('system', `Error: ${data.message}`);
  eventSource?.close();
}

/* ─── Payload review modal ──────────────────────────────────────────────────── */
function onReviewRequired(data) {
  const labels = {
    create_quality_case: 'Create Quality Case',
    lock_inventory:      'Lock Inventory',
  };
  modalToolBadge.textContent = labels[data.toolName] || data.toolName;
  buildModalForm(data.toolName, data.payload);
  reviewModal.classList.remove('hidden');
  addChatMessage('system', `⚠ Review payload for "${labels[data.toolName] || data.toolName}" before executing.`);
}

function buildModalForm(toolName, payload) {
  const fields = REVIEW_FIELDS[toolName] || [];
  modalBody.innerHTML = '';

  for (const field of fields) {
    const val = payload[field.key];
    if (val === undefined && !field.editable) continue;

    const row = document.createElement('div');
    row.className = 'review-field';

    const lbl = document.createElement('label');
    lbl.className = `review-label${field.editable ? ' editable' : ''}`;
    lbl.textContent = field.label;
    row.appendChild(lbl);

    if (field.editable) {
      if (field.type === 'textarea') {
        const ta = document.createElement('textarea');
        ta.className = 'review-input'; ta.dataset.key = field.key;
        ta.value = String(val ?? ''); ta.rows = 3;
        row.appendChild(ta);
      } else if (field.type === 'select') {
        const sel = document.createElement('select');
        sel.className = 'review-input'; sel.dataset.key = field.key;
        (field.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          if (opt === (val || field.options[1])) o.selected = true;
          sel.appendChild(o);
        });
        row.appendChild(sel);
      } else {
        const inp = document.createElement('input');
        inp.className = 'review-input'; inp.dataset.key = field.key;
        inp.type = 'text';
        inp.value = Array.isArray(val) ? val.join(', ') : String(val ?? '');
        row.appendChild(inp);
      }
    } else {
      const div = document.createElement('div');
      div.className = 'review-value';
      div.textContent = Array.isArray(val) ? val.join(', ') : String(val ?? '—');
      row.appendChild(div);
    }

    modalBody.appendChild(row);
  }
}

async function submitReview(approved) {
  reviewModal.classList.add('hidden');

  const overrides = {};
  if (approved) {
    modalBody.querySelectorAll('.review-input').forEach(el => {
      overrides[el.dataset.key] = el.value;
    });
  }

  try {
    await fetch('/api/review-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, approved, overrides }),
    });
  } catch (err) {
    addChatMessage('system', `Review submit failed: ${err.message}`);
  }
}

/* ─── Confirmation ──────────────────────────────────────────────────────────── */
async function sendConfirmation(confirmed) {
  btnConfirm.disabled = true;
  btnCancel.disabled  = true;

  addChatMessage('user', confirmed ? '✓ Confirmed — proceed.' : '✕ Cancelled.');

  try {
    await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, confirmed }),
    });
  } catch (err) {
    addChatMessage('system', `Confirm request failed: ${err.message}`);
  }

  if (!confirmed) sectionActions.classList.add('hidden');
  else            sectionActions.classList.add('hidden');
}

/* ─── Plan rendering ────────────────────────────────────────────────────────── */
function renderPlan() {
  planContent.innerHTML = '';
  planContent.querySelector?.('.empty-state')?.remove();

  planSteps.forEach((step, i) => {
    const icon = statusIcon(step.status);
    const el = document.createElement('div');
    el.className = `plan-step ${step.status}`;
    el.dataset.index = i;
    el.innerHTML = `
      <div class="step-num">${step.index}</div>
      <div class="step-body">
        <div class="step-tool">${esc(step.tool)}</div>
        <div class="step-desc">${esc(step.description)}</div>
      </div>
      <div class="step-status-icon">${icon}</div>`;
    planContent.appendChild(el);
  });
}

/* ─── Log entry builders ────────────────────────────────────────────────────── */
function buildLogEntry(stepIndex, toolName, status, payload, summary, result) {
  const el = document.createElement('div');
  el.className = `log-entry ${status}`;
  el.dataset.toolId = `${toolName}-${stepIndex}`;

  const payloadJson = JSON.stringify(payload, null, 2);
  const resultJson  = result ? JSON.stringify(result, null, 2) : null;

  el.innerHTML = `
    <div class="log-header">
      <span class="log-step-num">#${stepIndex}</span>
      <span class="log-tool-name">${esc(toolName)}</span>
      <span class="log-summary">${esc(summary || '')}</span>
      <span class="log-status">${statusIcon(status)}</span>
    </div>
    <div class="log-detail">
      <div class="log-label">Request Payload</div>
      <pre class="log-json">${esc(payloadJson)}</pre>
      ${resultJson ? `<div class="log-label">Response</div><pre class="log-json">${esc(resultJson)}</pre>` : ''}
    </div>`;

  el.querySelector('.log-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
  });

  return el;
}

function updateLogEntry(toolId, toolName, status, summary, result) {
  // Find by step number embedded in toolId attr or iterate
  const all = logsContent.querySelectorAll('.log-entry');
  let el = null;

  // Find the last 'running' entry with this tool name
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].classList.contains('running') &&
        all[i].querySelector('.log-tool-name')?.textContent === toolName) {
      el = all[i]; break;
    }
  }
  if (!el) return;

  el.className = `log-entry ${status}`;
  const summaryEl = el.querySelector('.log-summary');
  const statusEl  = el.querySelector('.log-status');
  if (summaryEl) summaryEl.textContent = summary || '';
  if (statusEl)  statusEl.textContent  = statusIcon(status);

  if (result) {
    const detail  = el.querySelector('.log-detail');
    const existing = detail.querySelector('.log-json:last-of-type');
    if (!detail.querySelector('[data-result]')) {
      const label = document.createElement('div');
      label.className = 'log-label';
      label.textContent = 'Response';
      const pre = document.createElement('pre');
      pre.className = 'log-json';
      pre.dataset.result = '1';
      pre.textContent = JSON.stringify(result, null, 2);
      detail.appendChild(label);
      detail.appendChild(pre);
    }
  }
}

/* ─── Results rendering ─────────────────────────────────────────────────────── */
function renderResults(data) {
  resultsContent.querySelector('.empty-state')?.remove();

  // Stats cards
  const statsHtml = `
    <div class="stats-row">
      <div class="stat-card stat-total">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">Total Steps</div>
      </div>
      <div class="stat-card stat-success">
        <div class="stat-value">${stats.success}</div>
        <div class="stat-label">Succeeded</div>
      </div>
      <div class="stat-card stat-failed">
        <div class="stat-value">${stats.failed}</div>
        <div class="stat-label">Failed</div>
      </div>
    </div>`;

  let summaryHtml = '';
  if (data.summary) {
    summaryHtml = `<div class="result-summary md-body">${md(data.summary)}</div>`;
  }

  let tablesHtml = '';
  for (const [toolName, items] of Object.entries(tableData)) {
    if (!items?.length) continue;
    tablesHtml += buildTable(toolName, items);
  }

  resultsContent.innerHTML = statsHtml + summaryHtml + tablesHtml;
}

function captureTableData(toolName, result) {
  if (result?.items?.length) {
    tableData[toolName] = result.items;
  }
}

function updateStatsDisplay() {
  const existing = resultsContent.querySelector('.stats-row');
  if (!existing) return;
  existing.querySelector('.stat-total .stat-value').textContent   = stats.total;
  existing.querySelector('.stat-success .stat-value').textContent = stats.success;
  existing.querySelector('.stat-failed .stat-value').textContent  = stats.failed;
}

/* Columns that reference entity identifiers — rendered cyan */
const CYAN_COLS  = new Set(['case_number','target_value','affected_lot_lpn','item_number','case_lock_id','lpn','lpn_number']);
/* Status values that signal a warning/damage state — rendered amber */
const WARN_RE    = /^(LOCK|LOCKED|DAMAGE|DAMAGED|WARNING|HOLD|BLOCKED)/i;

function cellClass(colKey, value) {
  if (CYAN_COLS.has(colKey)) return ' class="cell-cyan"';
  if (colKey === 'status' && WARN_RE.test(value)) return ' class="cell-amber"';
  return '';
}

function buildTable(toolName, items) {
  if (!items?.length) return '';

  const label = toolLabel(toolName);
  const keys  = Object.keys(items[0]).filter(k => !k.startsWith('_'));
  const PRIORITY = ['id','case_number','case_type_name','status','description','affected_lot_lpn',
                    'assigned_to','priority_level','created_date','target_value','target_type',
                    'reason_code','lock_comments','item_number'];
  const sorted = [
    ...PRIORITY.filter(k => keys.includes(k)),
    ...keys.filter(k => !PRIORITY.includes(k)),
  ].slice(0, 10);

  const thead = sorted.map(k => `<th>${esc(k.replace(/_/g,' '))}</th>`).join('');
  const tbody = items.slice(0, 50).map(row =>
    `<tr>${sorted.map(k => {
      const v = String(row[k] ?? '');
      return `<td${cellClass(k, v)} title="${esc(v)}">${esc(v)}</td>`;
    }).join('')}</tr>`
  ).join('');

  return `
    <div class="result-section-title">${esc(label)} (${items.length})</div>
    <div class="data-table-wrapper">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

/* ─── Chat helpers ──────────────────────────────────────────────────────────── */
function addChatMessage(role, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;

  if (role === 'system') {
    el.innerHTML = `<div class="chat-bubble">${esc(text)}</div>`;
  } else if (role === 'user') {
    el.innerHTML = `
      <div class="chat-avatar">ME</div>
      <div class="chat-bubble">${esc(text)}</div>`;
  } else {
    // assistant — render full markdown (tables, bold, lists, code)
    el.innerHTML = `
      <div class="chat-avatar">AI</div>
      <div class="chat-bubble md-body">${md(text)}</div>`;
  }

  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeWelcome() {
  chatMessages.querySelector('.chat-welcome')?.remove();
}

/* ─── Workspace reset ───────────────────────────────────────────────────────── */
function clearWorkspace() {
  planSteps  = [];
  logCount   = 0;
  stats      = { total: 0, success: 0, failed: 0 };
  tableData  = {};

  planContent.innerHTML    = `<div class="empty-state">Plan will appear here after you send a command.</div>`;
  planImpact.classList.add('hidden');
  planStepCount.textContent = '';
  logsContent.innerHTML    = `<div class="empty-state">Execution steps will appear here during agent run.</div>`;
  logCountBadge.textContent = '';
  resultsContent.innerHTML = `<div class="empty-state">Results will appear here after execution.</div>`;
  sectionActions.classList.add('hidden');
  sectionDoc?.classList.add('hidden');
  sectionPO?.classList.add('hidden');
  sectionASN?.classList.add('hidden');
  pendingASNPayload = null;
  parsedASNData     = null;
}

function newSession() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  sessionId = null;
  clearWorkspace();
  chatMessages.innerHTML = `
    <div class="chat-welcome">
      <div class="welcome-icon">Q</div>
      <p class="welcome-title">QCM Agent ready</p>
      <p class="welcome-hint">Describe what you need in plain language.</p>
      <div class="example-prompts">
        <button class="example-btn" data-prompt="Show me all open quality cases">Show open cases</button>
        <button class="example-btn" data-prompt="Get available case types">List case types</button>
        <button class="example-btn" data-prompt="Show me all active inventory locks">Active locks</button>
        <button class="example-btn" data-prompt="Create a quality case for damaged item LPN-001 at facility MAIN">Create case</button>
        <button class="example-btn example-btn-asn" data-prompt="Create ASN">Create ASN</button>
      </div>
    </div>`;
  document.querySelectorAll('.example-btn').forEach(btn => {
    btn.addEventListener('click', () => { chatInput.value = btn.dataset.prompt; chatInput.focus(); });
  });
  setStatus('idle');
  btnSend.disabled = false;
}

/* ─── Status helper ─────────────────────────────────────────────────────────── */
function setStatus(status) {
  const labels = {
    idle: 'Idle', planning: 'Planning', awaiting: 'Awaiting',
    executing: 'Executing', complete: 'Complete',
    failed: 'Error', cancelled: 'Cancelled',
  };
  agentBadge.className = `status-badge ${status}`;
  agentBadge.textContent = labels[status] || status;

  if (panelDot) {
    panelDot.className = ['executing','planning','awaiting'].includes(status) ? 'panel-dot active' : 'panel-dot';
  }
}

/* ─── Utilities ─────────────────────────────────────────────────────────────── */
function statusIcon(status) {
  return { pending: '◦', running: '⏳', success: '✓', failed: '✗' }[status] ?? '·';
}

function toolLabel(toolName) {
  return {
    get_quality_cases:     'Quality Cases',
    create_quality_case:   'Created Cases',
    get_case_types:        'Case Types',
    get_reason_codes:      'Reason Codes',
    lock_inventory:        'Inventory Locks Created',
    unlock_inventory:      'Inventory Unlocked',
    get_case_lock_mappings:'Active Lock Mappings',
    get_case_audit:        'Case Audit Trail',
    get_lock_audit:        'Lock Audit History',
  }[toolName] ?? toolName;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '\n'); // preserve newlines in pre elements
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ─── File upload / ASN flow ─────────────────────────────────────────────── */

function setupFileUpload() {
  const input = $('file-upload');
  if (!input) return;
  input.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    input.value = '';
  });
}

async function handleFileSelect(file) {
  removeWelcome();

  addFilePreviewMessage(file);
  addChatMessage('system', '🔍 Parsing packing slip…');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res  = await fetch('/api/upload-document', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      addChatMessage('system', `Upload failed: ${data.error || res.statusText}`);
      return;
    }

    const { parsed, poData, asnPayload, fusionBaseUrl, fusionUiBaseUrl, fusionOrgId } = data;

    parsedASNData     = { parsed, poData, asnPayload, fusionBaseUrl, fusionUiBaseUrl, fusionOrgId };
    pendingASNPayload = asnPayload;

    const po    = esc(parsed.customerPONumber || parsed.poNumber || '');
    const lines = parsed.lineItems?.length || 0;
    addChatMessage('assistant',
      `Packing slip parsed successfully!\n\n**PO:** ${po}  **BOL:** ${esc(parsed.bolNumber || '')}  **Lines:** ${lines} LPNs\n\nType **"create ASN"** to review the payload and submit to Oracle Fusion.`);

  } catch (err) {
    addChatMessage('system', `Upload error: ${err.message}`);
  }
}

function addFilePreviewMessage(file) {
  const el = document.createElement('div');
  el.className = 'chat-msg file-preview user';

  const isPDF   = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const blobUrl = URL.createObjectURL(file);
  const sizeMB  = (file.size / 1_048_576).toFixed(1);

  const meta = `${isPDF ? 'PDF' : 'DOCX'} · ${sizeMB} MB`;
  const icon = isPDF ? '📄' : '📝';

  el.innerHTML = `
    <div class="chat-avatar">ME</div>
    <div class="chat-bubble file-bubble">
      <div class="file-bubble-header">
        <span class="file-bubble-icon">${icon}</span>
        <div>
          <div class="file-bubble-name">${esc(file.name)}</div>
          <div class="file-bubble-meta">${meta}</div>
        </div>
      </div>
      ${isPDF ? `<iframe class="file-preview-pdf" src="${blobUrl}" title="${esc(file.name)}"></iframe>` : ''}
    </div>`;

  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderDocSection(parsed) {
  docContent.innerHTML = '';

  const fields = [
    { label: 'PO Number',    value: parsed.poNumber },
    { label: 'Customer PO', value: parsed.customerPONumber },
    { label: 'BOL Number',  value: parsed.bolNumber },
    { label: 'Ship Date',   value: parsed.shipDate },
    { label: 'Item Code',   value: parsed.itemCode },
  ];

  const grid = document.createElement('div');
  grid.className = 'doc-fields-grid';
  fields.forEach(({ label, value }) => {
    if (!value) return;
    const div = document.createElement('div');
    div.className = 'doc-field';
    div.innerHTML = `<div class="doc-field-label">${esc(label)}</div>
                     <div class="doc-field-value">${esc(String(value))}</div>`;
    grid.appendChild(div);
  });
  docContent.appendChild(grid);

  if (parsed.lineItems?.length) {
    const title = document.createElement('div');
    title.className = 'result-section-title';
    title.textContent = `Line Items (${parsed.lineItems.length})`;
    docContent.appendChild(title);

    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';
    wrapper.innerHTML = `
      <table class="data-table">
        <thead><tr><th>LPN</th><th>Lot</th><th>Qty</th><th>UOM</th><th>Expiry</th></tr></thead>
        <tbody>${parsed.lineItems.map(item => `<tr>
          <td class="cell-cyan">${esc(item.lpn  || '')}</td>
          <td>${esc(item.lot  || '—')}</td>
          <td>${esc(String(item.qty ?? ''))}</td>
          <td>${esc(item.uom  || '')}</td>
          <td>${esc(item.expiryDate || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    docContent.appendChild(wrapper);
  }

  sectionDoc.classList.remove('hidden');
}

function renderPOSection(poData, parsed, fusionBaseUrl, fusionUiBaseUrl) {
  const poNumber = parsed?.customerPONumber || parsed?.poNumber || '';

  if (!poData) {
    poContent.innerHTML = `<div class="po-not-found">
      <span>⚠</span> PO not found in Oracle Fusion — proceeding with empty vendor fields.
    </div>`;
    sectionPO.classList.remove('hidden');
    return;
  }

  const fields = [
    { label: 'Vendor Name',      value: poData.vendorName },
    { label: 'Vendor Site Code', value: poData.vendorSiteCode },
    { label: 'PO Lines',         value: `${(poData.lines || []).length} lines` },
  ];

  const grid = document.createElement('div');
  grid.className = 'doc-fields-grid';
  fields.forEach(({ label, value }) => {
    const div = document.createElement('div');
    div.className = 'doc-field';
    div.innerHTML = `<div class="doc-field-label">${esc(label)}</div>
                     <div class="doc-field-value">${esc(String(value || '—'))}</div>`;
    grid.appendChild(div);
  });
  poContent.appendChild(grid);

  if (poData.lines?.length) {
    const title = document.createElement('div');
    title.className = 'result-section-title';
    title.textContent = `PO Lines (${poData.lines.length})`;
    poContent.appendChild(title);

    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';
    wrapper.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Line #</th><th>Item Number</th><th>Quantity</th><th>UOM</th></tr></thead>
        <tbody>${poData.lines.slice(0, 20).map(l => `<tr>
          <td>${esc(String(l.LineNumber || ''))}</td>
          <td class="cell-cyan">${esc(l.ItemNumber || '')}</td>
          <td>${esc(String(l.Quantity || ''))}</td>
          <td>${esc(l.UnitOfMeasure || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
    poContent.appendChild(wrapper);
  }

  const poHeaderId = poData?.poHeaderId;
  if (poHeaderId && fusionUiBaseUrl) {
    const url = `${fusionUiBaseUrl}/fndSetup/faces/deeplink` +
                `?objType=PURCHASE_ORDER&objKey=poHeaderId=${poHeaderId}&action=VIEW`;
    const link = document.createElement('a');
    link.href        = url;
    link.target      = '_blank';
    link.rel         = 'noopener noreferrer';
    link.className   = 'po-deep-link';
    link.textContent = `View PO ${poNumber} in Oracle Fusion →`;
    poContent.appendChild(link);
  }

  sectionPO.classList.remove('hidden');
}

function renderASNReview(parsed, poData, asnPayload) {
  const poNum = asnPayload.lines?.[0]?.DocumentNumber || parsed.customerPONumber || parsed.poNumber || '';

  const headerFields = [
    { label: 'PO Number',     value: poNum },
    { label: 'Shipment #',    value: asnPayload.ShipmentNumber },
    { label: 'BOL',           value: asnPayload.BOL },
    { label: 'Ship Date',     value: (asnPayload.ShippedDate || '').split('T')[0] },
    { label: 'Vendor',        value: asnPayload.VendorName },
    { label: 'Vendor Site',   value: asnPayload.VendorSiteCode },
    { label: 'Org Code',      value: asnPayload.OrganizationCode },
    { label: 'Business Unit', value: asnPayload.BusinessUnit },
    { label: 'ASN Type',      value: asnPayload.ASNType },
  ];

  asnReviewContent.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'doc-fields-grid';
  headerFields.forEach(({ label, value }) => {
    if (!value) return;
    const div = document.createElement('div');
    div.className = 'doc-field';
    div.innerHTML = `<div class="doc-field-label">${esc(label)}</div>
                     <div class="doc-field-value">${esc(String(value))}</div>`;
    grid.appendChild(div);
  });
  asnReviewContent.appendChild(grid);

  if (asnPayload.lines?.length) {
    const title = document.createElement('div');
    title.className = 'result-section-title';
    title.textContent = `Line Items (${asnPayload.lines.length})`;
    asnReviewContent.appendChild(title);

    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';
    wrapper.innerHTML = `
      <table class="data-table">
        <thead><tr><th>LPN</th><th>Item</th><th>Qty</th><th>UOM</th><th>Lot</th><th>Expiry</th></tr></thead>
        <tbody>${asnPayload.lines.map(li => {
          const lot = li.lotItemLots?.[0];
          return `<tr>
            <td class="cell-cyan">${esc(li.LicensePlateNumber || '')}</td>
            <td>${esc(li.ItemNumber || '')}</td>
            <td>${esc(String(li.Quantity || ''))}</td>
            <td>${esc(li.UnitOfMeasure || '')}</td>
            <td>${esc(lot?.LotNumber || '—')}</td>
            <td>${esc(lot?.LotExpirationDate || '—')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    asnReviewContent.appendChild(wrapper);
  }

  const bar = document.createElement('div');
  bar.className = 'asn-confirm-bar';
  bar.innerHTML = `
    <button id="btn-asn-confirm" class="btn btn-danger">Review &amp; Edit JSON →</button>
    <button id="btn-asn-cancel"  class="btn btn-ghost">Cancel</button>`;
  asnReviewContent.appendChild(bar);

  $('btn-asn-confirm').addEventListener('click', () => openASNEditor(pendingASNPayload));
  $('btn-asn-cancel').addEventListener('click',  cancelASN);

  sectionASN.classList.remove('hidden');
}

/* ── ASN header fields shown in the form ── */
const ASN_HEADER_FIELDS = [
  { key: 'VendorName',        label: 'Vendor Name',        numeric: false },
  { key: 'VendorSiteCode',    label: 'Vendor Site Code',   numeric: false },
  { key: 'ShipmentNumber',    label: 'Shipment Number',    numeric: true  },
  { key: 'ShippedDate',       label: 'Shipped Date',       numeric: false },
  { key: 'OrganizationCode',  label: 'Org Code',           numeric: false },
  { key: 'BusinessUnit',      label: 'Business Unit',      numeric: false },
  { key: 'ReceiptSourceCode', label: 'Receipt Source',     numeric: false },
  { key: 'ASNType',           label: 'ASN Type',           numeric: false },
  { key: 'EmployeeId',        label: 'Employee ID',        numeric: true  },
];

function openASNEditor(payload) {
  const container = $('asn-form-container');
  const errEl     = $('asn-json-error');
  container.innerHTML = '';
  errEl.classList.add('hidden');

  // ── Header section ──
  const hTitle = document.createElement('div');
  hTitle.className = 'asn-form-section-title';
  hTitle.textContent = 'Shipment Header';
  container.appendChild(hTitle);

  const grid = document.createElement('div');
  grid.className = 'asn-form-grid';
  ASN_HEADER_FIELDS.forEach(({ key, label }) => {
    const row = document.createElement('div');
    row.className = 'asn-form-row';
    row.innerHTML = `
      <label class="asn-form-label">${esc(label)}</label>
      <input class="asn-form-input" data-field="${key}"
             value="${esc(String(payload[key] ?? ''))}" />`;
    grid.appendChild(row);
  });
  container.appendChild(grid);

  // ── Line items section ──
  if (payload.lines?.length) {
    const lTitle = document.createElement('div');
    lTitle.className = 'asn-form-section-title';
    lTitle.textContent = `Line Items (${payload.lines.length})`;
    container.appendChild(lTitle);

    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';

    const thead = `<thead><tr>
      <th>#</th><th>LPN</th><th>Document #</th><th>Item Number</th>
      <th>Qty</th><th>UOM</th><th>Lot Number</th><th>Lot Expiry</th>
    </tr></thead>`;

    const rows = payload.lines.map((line, idx) => {
      const lot = line.lotItemLots?.[0];
      return `<tr>
        <td class="asn-line-num">${idx + 1}</td>
        <td><input class="asn-line-input cell-cyan"
                   data-li="${idx}" data-lk="LicensePlateNumber"
                   value="${esc(String(line.LicensePlateNumber || ''))}" /></td>
        <td><input class="asn-line-input" data-li="${idx}" data-lk="DocumentNumber"  value="${esc(String(line.DocumentNumber  || ''))}" /></td>
        <td><input class="asn-line-input" data-li="${idx}" data-lk="ItemNumber"      value="${esc(String(line.ItemNumber      || ''))}" /></td>
        <td><input class="asn-line-input asn-line-narrow" type="number" min="0"
                   data-li="${idx}" data-lk="Quantity"
                   value="${esc(String(line.Quantity ?? ''))}" /></td>
        <td><input class="asn-line-input asn-line-narrow"
                   data-li="${idx}" data-lk="UnitOfMeasure"
                   value="${esc(String(line.UnitOfMeasure || ''))}" /></td>
        <td><input class="asn-line-input"
                   data-li="${idx}" data-lk="_lotNumber"
                   value="${esc(lot?.LotNumber || '')}" /></td>
        <td><input class="asn-line-input"
                   data-li="${idx}" data-lk="_lotExpiry"
                   value="${esc(lot?.LotExpirationDate || '')}" /></td>
      </tr>`;
    }).join('');

    wrapper.innerHTML = `<table class="data-table asn-lines-table">${thead}<tbody>${rows}</tbody></table>`;
    container.appendChild(wrapper);
  }

  $('asn-edit-modal').classList.remove('hidden');
}

async function sendASNFromEditor() {
  const errEl   = $('asn-json-error');
  const sendBtn = $('btn-asn-edit-send');
  errEl.classList.add('hidden');

  // ── Read header fields ──
  const payload = JSON.parse(JSON.stringify(pendingASNPayload)); // deep clone

  $('asn-form-container').querySelectorAll('[data-field]').forEach(inp => {
    const key = inp.dataset.field;
    const val = inp.value.trim();
    const def = ASN_HEADER_FIELDS.find(f => f.key === key);
    payload[key] = (def?.numeric && val !== '') ? Number(val) : (val || payload[key]);
  });

  // ── Read line item edits ──
  const lineEdits = {};
  $('asn-form-container').querySelectorAll('[data-li]').forEach(inp => {
    const idx = Number(inp.dataset.li);
    const key = inp.dataset.lk;
    if (!lineEdits[idx]) lineEdits[idx] = {};
    lineEdits[idx][key] = inp.value.trim();
  });

  payload.lines = (pendingASNPayload?.lines || []).map((orig, idx) => {
    const e   = lineEdits[idx] || {};
    const qty = e.Quantity !== undefined ? Number(e.Quantity) || orig.Quantity : orig.Quantity;
    const line = {
      ...orig,
      //LicensePlateNumber: e.LicensePlateNumber ?? orig.LicensePlateNumber,
      DocumentNumber:     e.DocumentNumber     ?? orig.DocumentNumber,
      ItemNumber:         e.ItemNumber         ?? orig.ItemNumber,
      Quantity:           qty,
      UnitOfMeasure:      e.UnitOfMeasure      ?? orig.UnitOfMeasure,
    };
    if (line.lotItemLots?.[0]) {
      line.lotItemLots = [{ ...line.lotItemLots[0],
        LotNumber:           e._lotNumber ?? line.lotItemLots[0].LotNumber,
        LotExpirationDate:   e._lotExpiry  ?? line.lotItemLots[0].LotExpirationDate,
        TransactionQuantity: qty,
      }];
    }
    return line;
  });

  sendBtn.disabled    = true;
  sendBtn.textContent = 'Sending…';
  $('asn-edit-modal').classList.add('hidden');

  addChatMessage('system', '📤 Creating ASN in Oracle Fusion…');

  try {
    const res  = await fetch('/api/create-asn', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      let msg = `ASN creation failed: ${data.error || res.statusText}`;
      if (data.processingErrors?.length) {
        const lines = data.processingErrors.map(e => {
          const text = e.ErrorMessage || e.Message || e.errorMessage || JSON.stringify(e);
          return `- ${text}`;
        }).join('\n');
        msg += `\n\n**Processing errors:**\n${lines}`;
      } else if (data.detail) {
        msg += `\n\n\`\`\`json\n${JSON.stringify(data.detail, null, 2)}\n\`\`\``;
      }
      addChatMessage('assistant', msg);
      sendBtn.disabled    = false;
      sendBtn.textContent = 'Send to Oracle Fusion';
      $('asn-edit-modal').classList.remove('hidden');
      return;
    }

    const shipNum = data.ShipmentNumber || payload.ShipmentNumber;
    const poNum   = payload.lines?.[0]?.DocumentNumber || '';

    let searchLink = '';
    const { fusionBaseUrl, fusionOrgId } = parsedASNData || {};
    if (fusionBaseUrl && fusionOrgId) {
      const url = `${fusionBaseUrl}/fscmUI/redwood/receiving-shipments?organizationId=${encodeURIComponent(fusionOrgId)}`;
      searchLink = `\n\n[Search for shipment **${shipNum}** in Oracle Fusion →](${url})`;
    }

    addChatMessage('assistant',
      `✓ ASN created in Oracle Fusion!\n\n**Shipment:** ${shipNum}\n**PO:** ${poNum}${searchLink}`);

    sectionASN.classList.add('hidden');
    pendingASNPayload = null;
    parsedASNData     = null;

  } catch (err) {
    addChatMessage('system', `ASN request failed: ${err.message}`);
    sendBtn.disabled    = false;
    sendBtn.textContent = 'Send to Oracle Fusion';
  }
}

function cancelASN() {
  sectionASN.classList.add('hidden');
  sectionPO.classList.add('hidden');
  sectionDoc.classList.add('hidden');
  pendingASNPayload = null;
  addChatMessage('system', '✕ ASN creation cancelled.');
}
