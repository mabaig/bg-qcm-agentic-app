require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const PARSE_PROMPT = `You are parsing a packing slip document to create an ASN (Advanced Ship Notice) for Oracle Fusion.

Extract the data and return ONLY a valid JSON object — no explanation, no markdown fences:

{
  "customerPONumber": "the Customer PO # shown on the slip",
  "poNumber": "Oracle internal PO — extract from LPN prefix e.g. PO4776-LPN0309-35 becomes PO4776",
  "bolNumber": "BOL / Bill of Lading number as a string",
  "shipDate": "date shipped in YYYY-MM-DD",
  "itemCode": "item/SKU code e.g. INT_LT_ITEM",
  "lineItems": [
    {
      "lpn": "LPN exactly as shown",
      "lot": "lot number string or null if absent",
      "qty": 2,
      "uom": "EA or CS exactly as shown",
      "expiryDate": "YYYY-MM-DD or null"
    }
  ]
}

Rules:
- poNumber is always extracted from the LPN prefix (everything before -LPN)
- qty must be a number
- All dates in YYYY-MM-DD
- Return raw JSON only, starting with { and ending with }`;

async function parsePackingSlipPDF(fileBuffer) {
  const base64 = fileBuffer.toString('base64');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: PARSE_PROMPT },
      ],
    }],
  });

  return extractJSON(res);
}

async function parsePackingSlipText(text) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `${PARSE_PROMPT}\n\nPacking slip text:\n${text}`,
    }],
  });

  return extractJSON(res);
}

function extractJSON(res) {
  const text = res.content.find(c => c.type === 'text')?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not extract structured data from document');
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error('Parsed data is not valid JSON');
  }
}

// Oracle Fusion UOM codes differ from packing slip abbreviations
const UOM_MAP = { EA: 'Each', CS: 'Case', PL: 'Pallet', BX: 'Box', KG: 'Kilogram', LB: 'Pound' };

function buildASNPayload(parsed, poLines, config) {
  const { orgCode, businessUnit, legalEntity, employeeId, vendorName, vendorSiteCode } = config;

  // Build item → PO line number map
  const lineMap = {};
  (poLines || []).forEach(l => {
    if (l.ItemNumber) lineMap[l.ItemNumber] = Number(l.LineNumber || 1);
  });

  // Fusion uses the customer-facing PO number in DocumentNumber
  const documentNumber = parsed.customerPONumber || parsed.poNumber;

  const lines = parsed.lineItems.map(item => {
    const qty  = Number(item.qty);
    const uom  = UOM_MAP[item.uom] || item.uom || 'Each';

    const line = {
      AutoTransactCode:   'SHIP',
      DocumentLineNumber: lineMap[parsed.itemCode] || 1,
      DocumentNumber:     documentNumber,
      ItemNumber:         parsed.itemCode,
      //LicensePlateNumber: item.lpn,
      OrganizationCode:   orgCode,
      Quantity:           qty,
      ReceiptSourceCode:  'VENDOR',
      SoldtoLegalEntity:  legalEntity,
      SourceDocumentCode: 'PO',
      TransactionType:    'SHIP',
      UnitOfMeasure:      uom,
    };

    if (item.lot) {
      line.lotItemLots = [{
        LotExpirationDate:   item.expiryDate || null,
        LotNumber:           item.lot,
        TransactionQuantity: qty,
      }];
    }

    return line;
  });

  // Field order and shape matches the Oracle Fusion sample payload exactly.
  // Numeric ShipmentNumber: last 6 digits of epoch (avoids duplicates in testing).
  return {
    VendorName:        vendorName        || '',
    attachments:       [],
    DFF:               [],
    ShippedDate:       parsed.shipDate
                         ? `${parsed.shipDate}T00:00:00.000+00:00`
                         : new Date().toISOString(),
    ShipmentNumber:    parseInt(Date.now().toString().slice(-6), 10),
    ReceiptSourceCode: 'VENDOR',
    BusinessUnit:      businessUnit      || 'INT_BU',
    OrganizationCode:  orgCode           || 'INT_INV_IND',
    ASNType:           'ASN',
    EmployeeId:        employeeId ? Number(employeeId) : null,
    VendorSiteCode:    vendorSiteCode    || '',
    lines,
  };
}

module.exports = { parsePackingSlipPDF, parsePackingSlipText, buildASNPayload };
