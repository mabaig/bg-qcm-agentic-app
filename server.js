require('dotenv').config();
const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { runAgent } = require('./agent/agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
