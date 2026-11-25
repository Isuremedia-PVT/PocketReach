/**
 * BlueLink test bridge
 * ---------------------------------------------------------------------------
 * Two jobs:
 *   1. /send  : GoHighLevel calls this -> we ask BlueBubbles to send an iMessage
 *   2. /reply : BlueBubbles calls this -> we add a note on the GHL contact
 *
 * Secrets live in .env and are never logged.
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const {
  BB_URL = 'http://localhost:1234',
  BB_PASSWORD = '',
  GHL_TOKEN = '',
  GHL_LOCATION_ID = '',
  TEST_SECRET = '',
  PORT = 3000,
} = process.env;

const GHL_BASE = 'https://services.leadconnectorhq.com';

const app = express();
app.use(express.json({ limit: '1mb' }));
// GHL's "basic" webhook sometimes posts form-encoded data, so accept that too.
app.use(express.urlencoded({ extended: true }));

/** Turn anything like "(882) 653-0568" or "918826530568" into "+918826530568". */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d]/g, '');
  // 10 bare digits means a US/Canada number with no country code (GHL often
  // renders phone merge fields this way) - without this it gets treated as
  // the wrong country (e.g. +31 Netherlands) once we add the "+".
  if (digits.length === 10) digits = '1' + digits;
  return digits ? '+' + digits : '';
}

/** Common headers for every GoHighLevel API v2 call. */
function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_TOKEN}`,
    Version: '2021-07-28',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PocketReach</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22><rect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%230f172a%22/><path d=%22M16 20h32v18H30l-6 7v-7h-8z%22 fill=%22%2322c55e%22/></svg>">
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0f172a;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    text-align: center;
    padding: 2.5rem 3rem;
    border-radius: 16px;
    background: #1e293b;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.75rem;
  }
  p {
    margin: 0;
    color: #94a3b8;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22c55e;
    margin-right: 8px;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>PocketReach</h1>
    <p><span class="dot"></span>Service is up and running</p>
  </div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// GET /debug/env-status -> presence-only check (no values, no hashes, no
// secret required) of which env vars the running process sees. Safe to leave
// public since it reveals nothing beyond true/false.
// ---------------------------------------------------------------------------
app.get('/debug/env-status', (_req, res) => {
  res.json({
    BB_URL_set: !!BB_URL && BB_URL !== 'http://localhost:1234',
    BB_PASSWORD_set: !!BB_PASSWORD,
    GHL_TOKEN_set: !!GHL_TOKEN,
    GHL_LOCATION_ID_set: !!GHL_LOCATION_ID,
    TEST_SECRET_set: !!TEST_SECRET,
  });
});

// ---------------------------------------------------------------------------
// GET /debug/env?secret=... -> temporary check of which env vars the running
// process sees. Gated behind TEST_SECRET; no secret values are ever exposed,
// only whether each one loaded.
// ---------------------------------------------------------------------------
app.get('/debug/env', (req, res) => {
  // trim() tolerates stray whitespace/newlines some hosting panels add to env values
  const given = String(req.query.secret || '').trim();
  if (!TEST_SECRET || given !== String(TEST_SECRET).trim()) {
    return res.sendStatus(404);
  }
  // One-way fingerprint only -> lets you compare against a local value
  // without ever exposing the secret itself.
  const fingerprint = (v) =>
    v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : 'MISSING';
  const fingerprintRaw = (v) =>
    v ? crypto.createHash('sha256').update(String(v).trim()).digest('hex').slice(0, 8) : 'MISSING';
  res.json({
    BB_URL,
    BB_PASSWORD: fingerprint(BB_PASSWORD),
    GHL_TOKEN: fingerprint(GHL_TOKEN),
    GHL_TOKEN_trimmed: fingerprintRaw(GHL_TOKEN),
    GHL_LOCATION_ID: fingerprint(GHL_LOCATION_ID),
    GHL_LOCATION_ID_trimmed: fingerprintRaw(GHL_LOCATION_ID),
    TEST_SECRET: fingerprint(TEST_SECRET),
    TEST_SECRET_trimmed: fingerprintRaw(TEST_SECRET),
  });
});

// ---------------------------------------------------------------------------
// POST /send?secret=... -> hand the message to BlueBubbles
// ---------------------------------------------------------------------------
app.post('/send', async (req, res) => {
  // 1. Shared-secret gate. Without this anyone on the internet could send from your Mac.
  if (!TEST_SECRET || req.query.secret !== TEST_SECRET) {
    console.log('[send] rejected: bad or missing secret');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Pull the fields. GHL's basic webhook nests custom fields under customData.
  const body = req.body || {};
  const custom = body.customData || {};

  const phone = normalizePhone(body.phone || custom.phone);
  const message = body.message || custom.message || '';
  const serviceRaw = String(body.service || custom.service || '').toLowerCase();
  const service = serviceRaw === 'sms' ? 'SMS' : 'iMessage';

  if (!phone || !message) {
    console.log('[send] rejected: missing phone or message');
    return res.status(400).json({ error: 'phone and message are required' });
  }

  // 3. Build the BlueBubbles request.
  const url = `${BB_URL}/api/v1/message/text?password=${encodeURIComponent(BB_PASSWORD)}`;
  const payload = {
    chatGuid: `${service};-;${phone}`,
    message,
    method: 'apple-script',
    tempGuid: crypto.randomUUID(),
  };

  try {
    const bbRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await bbRes.text();

    // One tidy log line. The password is in the URL, so we never log the URL.
    console.log(`[send] ${service} -> ${phone} | status ${bbRes.status}`);

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return res.status(bbRes.status).json(parsed);
  } catch (err) {
    console.error(`[send] ${service} -> ${phone} | error: ${err.message}`);
    return res.status(502).json({ error: 'could not reach BlueBubbles', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Keeps the last few raw /reply calls in memory so we can confirm whether
// BlueBubbles' webhook is actually reaching this server, and in what shape.
// ---------------------------------------------------------------------------
const recentReplyCalls = [];

app.get('/debug/last-replies', (req, res) => {
  if (!TEST_SECRET || req.query.secret !== TEST_SECRET) {
    return res.sendStatus(404);
  }
  res.json(recentReplyCalls);
});

// ---------------------------------------------------------------------------
// POST /reply -> BlueBubbles webhook: log the reply as a note in GHL
// ---------------------------------------------------------------------------
app.post('/reply', (req, res) => {
  recentReplyCalls.unshift({ at: new Date().toISOString(), body: req.body });
  recentReplyCalls.length = Math.min(recentReplyCalls.length, 5);

  // Always answer BlueBubbles straight away so its webhook never times out.
  res.sendStatus(200);

  // Then do the slow work in the background.
  handleReply(req.body).catch((err) => {
    console.error(`[reply] unexpected error: ${err.message}`);
  });
});

async function handleReply(payload = {}) {
  if (payload.type !== 'new-message') {
    console.log(`[reply] ignored event type "${payload.type}"`);
    return;
  }

  const data = payload.data || {};
  if (data.isFromMe) {
    console.log('[reply] ignored: message was sent by us');
    return;
  }

  const phone = normalizePhone(data.handle && data.handle.address);
  const text = data.text || '';

  if (!phone) {
    console.log('[reply] ignored: no sender address on the message');
    return;
  }
  console.log(`[reply] incoming from ${phone}: ${JSON.stringify(text)}`);

  if (!GHL_TOKEN || !GHL_LOCATION_ID) {
    console.log('[reply] skipped GHL: GHL_TOKEN or GHL_LOCATION_ID is not set in .env');
    return;
  }

  // 1. Look the contact up by phone number.
  const searchUrl =
    `${GHL_BASE}/contacts/search/duplicate` +
    `?locationId=${encodeURIComponent(GHL_LOCATION_ID)}` +
    `&number=${encodeURIComponent(phone)}`;

  let contactId;
  try {
    const sRes = await fetch(searchUrl, { headers: ghlHeaders() });
    const sBody = await sRes.json().catch(() => ({}));
    if (!sRes.ok) {
      console.error(`[reply] contact search failed | status ${sRes.status} | ${JSON.stringify(sBody)}`);
      return;
    }
    contactId = sBody && sBody.contact && sBody.contact.id;
  } catch (err) {
    console.error(`[reply] contact search error: ${err.message}`);
    return;
  }

  if (!contactId) {
    console.log(`[reply] no GHL contact found for ${phone} - nothing to do`);
    return;
  }
  console.log(`[reply] found GHL contact ${contactId} for ${phone}`);

  // 2. Add the reply as a note on that contact.
  try {
    const nRes = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({ body: `iMessage reply from ${phone}:\n${text}` }),
    });
    const nBody = await nRes.json().catch(() => ({}));
    if (nRes.ok) {
      const noteId = nBody && nBody.note && nBody.note.id;
      console.log(`[reply] note added to contact ${contactId}${noteId ? ` (note ${noteId})` : ''}`);
    } else {
      console.error(`[reply] note failed | status ${nRes.status} | ${JSON.stringify(nBody)}`);
    }
  } catch (err) {
    console.error(`[reply] note error: ${err.message}`);
  }

  // 3. Tag the contact so GHL workflows can react to the reply.
  try {
    const tRes = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({ tags: ['replied-imessage'] }),
    });
    const tBody = await tRes.json().catch(() => ({}));
    if (tRes.ok) {
      console.log(`[reply] tagged contact ${contactId} with "replied-imessage"`);
    } else {
      console.error(`[reply] tag failed | status ${tRes.status} | ${JSON.stringify(tBody)}`);
    }
  } catch (err) {
    console.error(`[reply] tag error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`BlueLink test bridge listening on http://localhost:${PORT}`);
  console.log(`BlueBubbles URL: ${BB_URL}`);
  console.log(`Config loaded: BB_PASSWORD=${BB_PASSWORD ? 'set' : 'MISSING'}, ` +
    `TEST_SECRET=${TEST_SECRET ? 'set' : 'MISSING'}, ` +
    `GHL_TOKEN=${GHL_TOKEN ? 'set' : 'MISSING'}, ` +
    `GHL_LOCATION_ID=${GHL_LOCATION_ID ? 'set' : 'MISSING'}`);
});
