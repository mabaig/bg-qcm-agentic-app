// HTTP execution layer — translates tool calls into ORDS API requests

const BASE_URL = process.env.ORDS_BASE_URL ||
  'https://g4b9bc24e36abdb-atpintellinum.adb.us-ashburn-1.oraclecloudapps.com/ords/qcm_demo/quality';

function authHeaders() {
  if (process.env.ORDS_USERNAME && process.env.ORDS_PASSWORD) {
    const encoded = Buffer.from(`${process.env.ORDS_USERNAME}:${process.env.ORDS_PASSWORD}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  if (process.env.ORDS_BEARER_TOKEN) {
    return { Authorization: `Bearer ${process.env.ORDS_BEARER_TOKEN}` };
  }
  return {};
}

async function ordsGet(path, extraHeaders = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...extraHeaders },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function ordsPost(path, body = {}, { keepEmpty = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const clean = Object.fromEntries(
    Object.entries(body).filter(([, v]) => keepEmpty
      ? v !== undefined && v !== null
      : v !== undefined && v !== null && v !== '',
    ),
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(clean),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

async function ordsDelete(path, extraHeaders = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...extraHeaders },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
  return { success: true };
}

const toolExecutors = {
  async get_quality_cases(input) {
    const h = {};
    if (input.caseNumber) h.caseNumber = input.caseNumber;
    if (input.caseTypeName) h.caseTypeName = input.caseTypeName;
    if (input.caseType) h.caseType = input.caseType;
    if (input.status) h.status = input.status;
    if (input.facilityCode) h.facilityCode = input.facilityCode;
    return ordsGet('/case', h);
  },

  async create_quality_case(input) {
    return ordsPost('/case', {
      caseTypeId:        input.caseTypeId,
      description:       input.description,
      facilityCode:      input.facilityCode      || process.env.QCM_FACILITY_CODE,
      facilityId:        input.facilityId        ?? Number(process.env.QCM_FACILITY_ID),
      priorityLevel:     input.priorityLevel     || 'Medium',   // API expects title-case
      affectedLotLpn:    input.affectedLotLpn    || '',
      assingnedTo:       input.assignedTo        || 'ANY',      // API typo — double-s
      sourceApplication: input.sourceApplication || 'Web Application',
      action:            input.action            || 'New',
      status:            input.status            || 'NEW',
      caseResolution:    input.caseResolution    || '',
      closeComments:     input.closeComments     || '',
      userName:          process.env.QCM_USERNAME,
      loginId:           process.env.QCM_LOGIN_ID,
    });
  },

  async get_case_types(input) {
    const h = {};
    if (input.caseTypeName) h.caseTypeName = input.caseTypeName;
    if (input.caseTypeCode) h.caseTypeCode = input.caseTypeCode;
    if (input.isActive) h.isActive = input.isActive;
    return ordsGet('/case-types', h);
  },

  async get_reason_codes(input) {
    const h = {};
    if (input.reasonCode) h.reasonCode = input.reasonCode;
    if (input.severity) h.severity = input.severity;
    if (input.description) h.description = input.description;
    return ordsGet('/reason-code', h);
  },

  async lock_inventory(input) {
    // targetValue must be an array — normalise if the agent passes a plain string
    const targets = Array.isArray(input.targetValue)
      ? input.targetValue
      : [input.targetValue].filter(Boolean);

    return ordsPost('/case-lock-mapping', {
      case:         input.case        || '',
      caseId:       input.caseId,
      caseTypeId:   input.caseTypeId,
      priority:     input.priority    || 'Medium',
      description:  input.description || '',
      affectedLpn:  input.affectedLpn || '',
      assingnedTo:  input.assignedTo  || 'ANY',      // API field has typo — must match
      reasonCodeId: input.reasonCodeId,
      skuValue:     input.skuValue    || '',
      targetType:   input.targetType,
      lotNumber:    input.lotNumber   || '',
      targetValue:  targets,
      lockComments: input.lockComments || '',
      status:       'Completed',
      userName:     process.env.QCM_USERNAME,
      loginId:      process.env.QCM_LOGIN_ID,
    }, { keepEmpty: true });
  },

  async unlock_inventory(input) {
    return ordsPost('/case-unlock-mapping', {
      caseLockId: input.caseLockId,
      comments: input.comments,
    });
  },

  async get_case_lock_mappings(input) {
    const h = {};
    if (input.caseNumber) h.caseNumber = input.caseNumber;
    if (input.caseTypeName) h.caseTypeName = input.caseTypeName;
    if (input.itemNumber) h.itemNumber = input.itemNumber;
    if (input.targetValue) h.targetValue = input.targetValue;
    if (input.targetType) h.targetType = input.targetType;
    if (input.status) h.status = input.status;
    if (input.facilityCode) h.facilityCode = input.facilityCode;
    if (input.reasonCode) h.reasonCode = input.reasonCode;
    if (input.lotNumber) h.lotNumber = input.lotNumber;
    return ordsGet('/case-lock-mapping', h);
  },

  async get_case_audit(input) {
    const h = {};
    if (input.caseNumber) h.caseNumber = input.caseNumber;
    if (input.newStatus) h.newStatus = input.newStatus;
    if (input.oldStatus) h.oldStatus = input.oldStatus;
    if (input.assignedTo) h.assignedTo = input.assignedTo;
    if (input.newCaseType) h.newCaseType = input.newCaseType;
    if (input.priorityLevel) h.priorityLevel = input.priorityLevel;
    return ordsGet('/case-audit', h);
  },

  async get_lock_audit(input) {
    const h = {};
    if (input.caseNumber) h.caseNumber = input.caseNumber;
    if (input.caseTypeName) h.caseTypeName = input.caseTypeName;
    if (input.itemNumber) h.itemNumber = input.itemNumber;
    if (input.targetValue) h.targetValue = input.targetValue;
    if (input.status) h.status = input.status;
    if (input.facilityCode) h.facilityCode = input.facilityCode;
    if (input.reasonCode) h.reasonCode = input.reasonCode;
    return ordsGet('/case-lock-audit', h);
  },
};

async function executeTool(name, input) {
  const fn = toolExecutors[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  return fn(input);
}

module.exports = { executeTool };
