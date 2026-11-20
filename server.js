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
  const digits = String(raw).replace(/[^\d]/g, '');
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
  res.type('text/plain').send('BlueLink test bridge is running');
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
// POST /reply -> BlueBubbles webhook: log the reply as a note in GHL
// ---------------------------------------------------------------------------
app.post('/reply', (req, res) => {
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
