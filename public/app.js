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
  return marked.parse(String(text ?? ''));
}

/* ─── State ────────────────────────────────────────────────────────────────── */
let sessionId   = null;
let eventSource = null;
let planSteps   = [];
let logCount    = 0;
let stats       = { total: 0, success: 0, failed: 0 };
let tableData   = {};   // toolName → result array, for result tables

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

/* ─── Init ─────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  chatInput.addEventListener('keydown', onInputKeydown);
  btnSend.addEventListener('click', sendMessage);
  btnNewSession.addEventListener('click', newSession);
  btnConfirm.addEventListener('click', () => sendConfirmation(true));
  btnCancel.addEventListener('click',  () => sendConfirmation(false));
  btnBell.addEventListener('click', onBellClick);
  btnModalConfirm.addEventListener('click', () => submitReview(true));
  btnModalCancel.addEventListener('click',  () => submitReview(false));

  document.querySelectorAll('.example-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      chatInput.value = btn.dataset.prompt;
      chatInput.focus();
    });
  });

  pollOpenCases();
  setInterval(pollOpenCases, 60_000);
});

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
  clearWorkspace();

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
}

function onCancelled(data) {
  setStatus('cancelled');
  btnSend.disabled = false;
  sectionActions.classList.add('hidden');
  addChatMessage('system', `✕ ${data.message}`);
  eventSource?.close();
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
  ].slice(0, 10); // cap columns

  const thead = sorted.map(k => `<th>${esc(k.replace(/_/g,' '))}</th>`).join('');
  const tbody = items.slice(0, 50).map(row =>
    `<tr>${sorted.map(k => `<td title="${esc(String(row[k] ?? ''))}">${esc(String(row[k] ?? ''))}</td>`).join('')}</tr>`
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
