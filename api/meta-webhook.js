// Vercel must supply the original bytes to validate Meta's delivery signature.
const { createHmac, timingSafeEqual } = require('node:crypto');

async function rawBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function metaWebhook(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const query = new URL(req.url, 'https://crm.invalid').searchParams;
    const token = process.env.META_WEBHOOK_VERIFY_TOKEN;
    const challenge = query.get('hub.challenge');
    if (!token || query.get('hub.mode') !== 'subscribe' || query.get('hub.verify_token') !== token || !/^\d+$/.test(challenge || '')) {
      return res.status(403).end();
    }
    return res.status(200).send(challenge);
  }
  if (req.method !== 'POST') return res.status(405).end();
  const { META_APP_SECRET, TOUR_API_URL, TOUR_API_SECRET } = process.env;
  if (!META_APP_SECRET || !TOUR_API_SECRET || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(TOUR_API_URL || '')) {
    return res.status(503).end();
  }
  try {
    const raw = await rawBody(req);
    const header = req.headers['x-hub-signature-256'] || '';
    const expected = createHmac('sha256', META_APP_SECRET).update(raw).digest();
    if (!/^sha256=[a-f0-9]{64}$/i.test(header) || !timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))) {
      return res.status(403).end();
    }
    const event = JSON.parse(raw.toString('utf8'));
    const response = await fetch(TOUR_API_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action:'socialWebhook', secret:TOUR_API_SECRET, event}),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok || (await response.json())?.ok !== true) return res.status(502).end();
    return res.status(200).send('EVENT_RECEIVED');
  } catch {
    return res.status(502).end();
  }
};

// The handler reads a raw stream. Vercel Node functions also expose the parsed
// body lazily, so this handler never accesses req.body.
