require('dotenv').config();
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');
const { runAgent } = require('./agent/agent');
const { parsePackingSlipPDF, parsePackingSlipText, buildASNPayload } = require('./agent/asn-parser');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── Oracle Fusion helpers ─────────────────────────────────────────────────
const FUSION_BASE    = (process.env.FUSION_BASE_URL    || 'https://eohx-test.fa.us6.oraclecloud.com').replace(/\/$/, '');
const FUSION_UI_BASE = (process.env.FUSION_UI_BASE_URL || 'https://eohx.fa.us6.oraclecloud.com').replace(/\/$/, '');

function fusionHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.FUSION_USERNAME && process.env.FUSION_PASSWORD) {
    const tok = Buffer.from(`${process.env.FUSION_USERNAME}:${process.env.FUSION_PASSWORD}`).toString('base64');
    h.Authorization = `Basic ${tok}`;
  }
  return h;
}

async function fetchPOFromFusion(poNumber) {
  const url = `${FUSION_BASE}/fscmRestApi/resources/latest/purchaseOrders` +
              `?q=OrderNumber=${encodeURIComponent(poNumber)}&expand=lines&limit=1`;
  try {
    const res = await fetch(url, { headers: fusionHeaders(), signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json();
    const po = data.items?.[0];
    if (!po) return null;
    return {
      vendorName:     po.Supplier     || po.VendorName     || '',
      vendorSiteCode: po.SupplierSite || po.VendorSiteCode || '',
      poHeaderId:     po.POHeaderId   || null,
      lines:          po.lines?.items || [],
    };
  } catch { return null; }
}

// ── Packing slip upload & parse ───────────────────────────────────────────
app.post('/api/upload-document', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { mimetype, originalname, buffer } = req.file;
    const isPDF  = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf');
    const isDOCX = mimetype.includes('word') || originalname.toLowerCase().endsWith('.docx');

    if (!isPDF && !isDOCX) {
      return res.status(400).json({ error: 'Unsupported format. Upload a PDF or DOCX file.' });
    }

    let parsed;
    if (isPDF) {
      parsed = await parsePackingSlipPDF(buffer);
    } else {
      const mammoth = require('mammoth');
      const { value: text } = await mammoth.extractRawText({ buffer });
      parsed = await parsePackingSlipText(text);
    }

    const poData = await fetchPOFromFusion(parsed.poNumber);

    const config = {
      orgCode:        process.env.FUSION_ORG_CODE       || 'INT_INV_IND',
      businessUnit:   process.env.FUSION_BUSINESS_UNIT   || 'INT_BU',
      legalEntity:    process.env.FUSION_LEGAL_ENTITY    || 'INT_LE',
      employeeId:     process.env.FUSION_EMPLOYEE_ID     || null,
      vendorName:     poData?.vendorName     || '',
      vendorSiteCode: poData?.vendorSiteCode || '',
    };

    const asnPayload = buildASNPayload(parsed, poData?.lines || [], config);
    res.json({
      parsed,
      poData,
      asnPayload,
      fusionBaseUrl:   FUSION_BASE,
      fusionUiBaseUrl: FUSION_UI_BASE,
      fusionOrgId:     process.env.FUSION_ORG_ID || null,
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ASN error helpers ──────────────────────────────────────────────────────
function hasReturnStatusError(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.ReturnStatus === 'ERROR') return true;
  return Object.values(obj).some(v =>
    Array.isArray(v) ? v.some(hasReturnStatusError) : false
  );
}

async function collectProcessingErrors(obj) {
  const errors = [];
  const seen   = new Set();

  async function scan(node) {
    if (!node || typeof node !== 'object') return;
    const links = Array.isArray(node.links) ? node.links : [];
    for (const link of links) {
      if (link.name === 'processingErrors' && link.href && !seen.has(link.href)) {
        seen.add(link.href);
        try {
          const r = await fetch(link.href, { headers: fusionHeaders(), signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const d = await r.json();
            if (d.items?.length) errors.push(...d.items);
          }
        } catch { /* ignore network errors on child fetch */ }
      }
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) for (const item of val) await scan(item);
    }
  }

  await scan(obj);
  return errors;
}

// ── Create ASN in Oracle Fusion ────────────────────────────────────────────
app.post('/api/create-asn', async (req, res) => {
  try {
    const payload = req.body;
    const url = `${FUSION_BASE}/fscmRestApi/resources/latest/receivingReceiptRequests`;
    const response = await fetch(url, {
      method:  'POST',
      headers: fusionHeaders(),
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(30000),
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.title || 'Fusion API error', detail: data });
    }

    // Oracle returns HTTP 201 even for business-level failures — check ReturnStatus
    if (hasReturnStatusError(data)) {
      const processingErrors = await collectProcessingErrors(data);
      return res.status(422).json({
        error:            'ASN creation failed in Oracle Fusion',
        processingErrors,
        raw:              data,
      });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// In-memory session store: sessionId → { messages, status, pendingConfirmation }
const sessions = new Map();
// SSE response objects: sessionId → res
const sseClients = new Map();

function sendSSE(sessionId, event, data) {
  const client = sseClients.get(sessionId);
  if (client && !client.destroyed) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ── Login ─────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.APP_USERNAME || 'intellinum.scm';
  const validPass = process.env.APP_PASSWORD || 'Welcome10';
  if (username === validUser && password === validPass) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid username or password.' });
  }
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── SSE stream subscription ───────────────────────────────────────────────
app.get('/api/stream/:sessionId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { sessionId } = req.params;
  sseClients.set(sessionId, res);

  // Keepalive ping every 20 s to prevent proxy/Vercel timeouts
  const ping = setInterval(() => {
    if (!res.destroyed) res.write(': ping\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(sessionId);
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ sessionId })}\n\n`);
});

// ── Start agent run ───────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId: existingId } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  const sessionId = existingId || randomUUID();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], status: 'idle', pendingConfirmation: null, pendingReview: null });
  }

  const session = sessions.get(sessionId);
  session.messages.push({ role: 'user', content: message.trim() });
  session.status = 'running';

  // Return session ID immediately so the client can subscribe to SSE
  res.json({ sessionId });

  // Run agent asynchronously — emits SSE events as it progresses
  runAgent(session, sessionId, sendSSE.bind(null, sessionId)).catch(err => {
    console.error('Agent error:', err);
    sendSSE(sessionId, 'error', { message: err.message });
    session.status = 'error';
  });
});

// ── Confirm or cancel pending action ─────────────────────────────────────
app.post('/api/confirm', (req, res) => {
  const { sessionId, confirmed } = req.body;
  const session = sessions.get(sessionId);

  if (!session || !session.pendingConfirmation) {
    return res.status(400).json({ error: 'No pending confirmation for this session' });
  }

  session.pendingConfirmation.resolve(!!confirmed);
  session.pendingConfirmation = null;
  res.json({ ok: true });
});

// ── Review and approve a pending tool-call payload ───────────────────────
app.post('/api/review-approve', (req, res) => {
  const { sessionId, approved, overrides } = req.body;
  const session = sessions.get(sessionId);

  if (!session || !session.pendingReview) {
    return res.status(400).json({ error: 'No pending review for this session' });
  }

  session.pendingReview.resolve({ approved: !!approved, overrides: overrides || {} });
  session.pendingReview = null;
  res.json({ ok: true });
});

// ── Session state (for reconnects) ───────────────────────────────────────
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: session.status, messageCount: session.messages.length });
});

// ── Open cases count (bell notification) ──────────────────────────────────
app.get('/api/open-cases-count', async (_, res) => {
  try {
    const base = process.env.ORDS_BASE_URL ||
      'https://g4b9bc24e36abdb-atpintellinum.adb.us-ashburn-1.oraclecloudapps.com/ords/qcm_demo/quality';

    const headers = { 'Content-Type': 'application/json', status: 'OPEN' };
    if (process.env.ORDS_USERNAME && process.env.ORDS_PASSWORD) {
      const token = Buffer.from(`${process.env.ORDS_USERNAME}:${process.env.ORDS_PASSWORD}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    } else if (process.env.ORDS_BEARER_TOKEN) {
      headers.Authorization = `Bearer ${process.env.ORDS_BEARER_TOKEN}`;
    }

    const resp = await fetch(`${base}/case`, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return res.json({ count: 0 });

    const data = await resp.json();
    const count = data.items?.[0]?.total_results ?? data.items?.length ?? 0;
    res.json({ count: Number(count) });
  } catch {
    res.json({ count: 0 });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

// On Vercel the runtime calls the exported handler directly — no listen() needed.
// Locally (npm run dev) we start the server normally.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀  QCM Agentic App  →  http://localhost:${PORT}\n`);
  });
}

module.exports = app;
