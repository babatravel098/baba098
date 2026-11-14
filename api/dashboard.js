const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const clientId = '679114631889-9r6mtbtm8el7t87s4e3m1aii2g0nj7gk.apps.googleusercontent.com';
const google = new OAuth2Client(clientId);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const wantsBookings = req.method === 'GET' &&
    new URL(req.url, 'https://crm.invalid').searchParams.get('data') === 'bookings';

  const credential = req.method === 'POST'
    ? req.body?.credential
    : /(?:^|;\s*)baba_google=([^;]+)/.exec(req.headers.cookie || '')?.[1];

  let identity;
  try {
    if (typeof credential !== 'string' || credential.length > 3500) {
      throw new Error('Invalid credential');
    }

    const ticket = await google.verifyIdToken({
      idToken: credential,
      audience: clientId
    });

    identity = ticket.getPayload();
    if (!identity?.email_verified || identity.email !== 'babatourandtravel098@gmail.com') {
      throw new Error('Account not allowed');
    }
  } catch {
    if (wantsBookings) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(401).end(JSON.stringify({ error: 'Please sign in again.' }));
    }
    return res.redirect(303, '/?login=denied');
  }

  if (req.method === 'POST') {
    const remaining = Math.max(0, identity.exp - Math.floor(Date.now() / 1000));
    res.setHeader(
      'Set-Cookie',
      'baba_google=' + credential +
        '; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=' + remaining
    );
    return res.redirect(303, '/api/dashboard');
  }

  if (wantsBookings) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    try {
      const auth = new GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      });

      const url = new URL(
        'https://sheets.googleapis.com/v4/spreadsheets/1I6cFI9mU3z8EPc5cRxNZy25cj3E4sO6xVnXHBFqUQsE/values:batchGet'
      );
      url.searchParams.append('ranges', 'Bookings!A1:R');
      url.searchParams.append('ranges', 'Payments!A1:I');

      const sheets = await auth.getClient();
      const { data } = await sheets.request({ url: url.href, timeout: 10000 });
      return res.end(JSON.stringify({ valueRanges: data.valueRanges }));
    } catch (error) {
      console.error('CRM Sheets read failed', error.response?.status ?? error.code ?? error.name);
      return res.status(502).end(JSON.stringify({ error: 'Could not load CRM bookings.' }));
    }
  }

  const html = fs.readFileSync(path.join(process.cwd(), 'lib', 'dashboard.html'), 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
};
