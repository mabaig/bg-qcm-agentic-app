// Tool definitions for the Claude agent matching the actual ORDS QCM API

const toolDefinitions = [
  {
    name: 'get_quality_cases',
    description: 'Retrieve quality cases from the QCM system. Can filter by case number, type, status, or facility. Returns case details including ID, case number, status, type, assigned user, and affected lot/LPN.',
    input_schema: {
      type: 'object',
      properties: {
        caseNumber: { type: 'string', description: 'Filter by specific case number (e.g., "QC-2024-001")' },
        caseTypeName: { type: 'string', description: 'Filter by case type name (e.g., "DAMAGE", "EXPIRED", "RECALL")' },
        caseType: { type: 'string', description: 'Filter by case type code' },
        status: { type: 'string', description: 'Filter by case status (e.g., "OPEN", "CLOSED", "IN_PROGRESS", "PENDING")' },
        facilityCode: { type: 'string', description: 'Filter by facility/warehouse code' },
      },
      required: [],
    },
  },
  {
    name: 'create_quality_case',
    description: 'Create a new quality case in the QCM system. Returns the new case ID and case number. NOTE: This is a write operation that requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        caseTypeId:        { type: 'number', description: 'Numeric ID of the case type — call get_case_types first if unknown' },
        description:       { type: 'string', description: 'Clear description of the quality issue' },
        facilityCode:      { type: 'string', description: 'Facility/warehouse code (e.g. "DC01") — defaults to env default if omitted' },
        priorityLevel:     { type: 'string', description: 'Priority: "High", "Medium", or "Low" (title-case required)' },
        affectedLotLpn:    { type: 'string', description: 'Affected lot number or LPN barcode' },
        assignedTo:        { type: 'string', description: 'Username to assign the case to (defaults to ANY)' },
        sourceApplication: { type: 'string', description: 'Source system label (defaults to "Web Application")' },
        action:            { type: 'string', description: 'Initial action, defaults to "New"' },
        status:            { type: 'string', description: 'Initial status, defaults to "NEW"' },
        caseResolution:    { type: 'string', description: 'Initial resolution notes if available' },
        closeComments:     { type: 'string', description: 'Close comments if applicable' },
      },
      required: ['description'],
    },
  },
  {
    name: 'get_case_types',
    description: 'Get all available quality case types including their IDs, names, and codes. Use this to find the correct caseTypeId before creating a case.',
    input_schema: {
      type: 'object',
      properties: {
        caseTypeName: { type: 'string', description: 'Filter by case type name' },
        caseTypeCode: { type: 'string', description: 'Filter by case type code' },
        isActive: { type: 'string', description: 'Filter by active status: Y (active only) or N (inactive only)' },
      },
      required: [],
    },
  },
  {
    name: 'get_reason_codes',
    description: 'Get available reason codes for quality cases and inventory locks. Includes severity levels and auto-lock flags.',
    input_schema: {
      type: 'object',
      properties: {
        reasonCode: { type: 'string', description: 'Filter by specific reason code' },
        severity: { type: 'string', description: 'Filter by severity: CRITICAL, HIGH, MEDIUM, LOW' },
        description: { type: 'string', description: 'Search by description text' },
      },
      required: [],
    },
  },
  {
    name: 'lock_inventory',
    description: 'Lock inventory in WMS by creating a case-lock mapping. This DIRECTLY calls the WMS Lock API and creates a record in QCM. CRITICAL OPERATION - always requires explicit user confirmation. Specify what type of inventory to lock (LPN, LOT, ITEM, or LOCATION) and the value.',
    input_schema: {
      type: 'object',
      properties: {
        caseId: { type: 'number', description: 'ID of the quality case to associate this lock with' },
        targetType: { type: 'string', description: 'Type of inventory target to lock: LPN, LOT, ITEM, or LOCATION' },
        targetValue: { type: 'string', description: 'The specific LPN barcode, lot number, item number, or location to lock' },
        reasonCode: { type: 'string', description: 'Reason code for the lock (get from get_reason_codes)' },
        lockComments: { type: 'string', description: 'Comments explaining why the inventory is being locked' },
        facilityCode: { type: 'string', description: 'Facility/warehouse code' },
        expiryDate: { type: 'string', description: 'Lock expiry date in ISO format (optional)' },
        lotNumber: { type: 'string', description: 'Lot number if locking by lot' },
        itemNumber: { type: 'string', description: 'Item/SKU number' },
        locationBarcode: { type: 'string', description: 'Location barcode if locking a location' },
        orderNumber: { type: 'string', description: 'Order number if locking for a specific order' },
        quantity: { type: 'number', description: 'Quantity to lock (if applicable)' },
      },
      required: ['caseId', 'targetType', 'targetValue'],
    },
  },
  {
    name: 'unlock_inventory',
    description: 'Unlock inventory in WMS by removing a case-lock mapping. This DIRECTLY calls the WMS Unlock API. CRITICAL OPERATION - always requires explicit user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        caseLockId: { type: 'number', description: 'ID of the case-lock mapping to remove (get from get_case_lock_mappings)' },
        comments: { type: 'string', description: 'Comments for the unlock action' },
      },
      required: ['caseLockId'],
    },
  },
  {
    name: 'get_case_lock_mappings',
    description: 'Get current inventory locks associated with quality cases. Shows what is currently locked, which case it belongs to, LPN/lot details, reason codes, and lock status.',
    input_schema: {
      type: 'object',
      properties: {
        caseNumber: { type: 'string', description: 'Filter by case number' },
        caseTypeName: { type: 'string', description: 'Filter by case type name' },
        itemNumber: { type: 'string', description: 'Filter by item/SKU number' },
        targetValue: { type: 'string', description: 'Filter by locked target value (LPN, lot, etc.)' },
        targetType: { type: 'string', description: 'Filter by target type: LPN, LOT, ITEM, LOCATION' },
        status: { type: 'string', description: 'Filter by lock status' },
        facilityCode: { type: 'string', description: 'Filter by facility code' },
        reasonCode: { type: 'string', description: 'Filter by reason code' },
        lotNumber: { type: 'string', description: 'Filter by lot number' },
      },
      required: [],
    },
  },
  {
    name: 'get_case_audit',
    description: 'Get the audit trail for quality cases — shows history of all status changes, reassignments, and updates with before/after values.',
    input_schema: {
      type: 'object',
      properties: {
        caseNumber: { type: 'string', description: 'Filter by case number' },
        newStatus: { type: 'string', description: 'Filter by new status after change' },
        oldStatus: { type: 'string', description: 'Filter by previous status before change' },
        assignedTo: { type: 'string', description: 'Filter by assigned user' },
        newCaseType: { type: 'string', description: 'Filter by new case type after change' },
        priorityLevel: { type: 'string', description: 'Filter by priority level' },
      },
      required: [],
    },
  },
  {
    name: 'get_lock_audit',
    description: 'Get the full lock audit history — shows all lock and unlock actions taken, including who performed them, when, and on what inventory.',
    input_schema: {
      type: 'object',
      properties: {
        caseNumber: { type: 'string', description: 'Filter by case number' },
        caseTypeName: { type: 'string', description: 'Filter by case type name' },
        itemNumber: { type: 'string', description: 'Filter by item number' },
        targetValue: { type: 'string', description: 'Filter by locked target (LPN, lot, item, location)' },
        status: { type: 'string', description: 'Filter by lock status' },
        facilityCode: { type: 'string', description: 'Filter by facility code' },
        reasonCode: { type: 'string', description: 'Filter by reason code' },
      },
      required: [],
    },
  },
];

// Tool names that are critical write operations requiring confirmation
const CRITICAL_TOOLS = new Set(['lock_inventory', 'unlock_inventory', 'create_quality_case']);

module.exports = { toolDefinitions, CRITICAL_TOOLS };
