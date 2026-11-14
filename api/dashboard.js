const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const clientId = '679114631889-9r6mtbtm8el7t87s4e3m1aii2g0nj7gk.apps.googleusercontent.com';
const allowedEmail = 'babatourandtravel098@gmail.com';
const sheetId = '1I6cFI9mU3z8EPc5cRxNZy25cj3E4sO6xVnXHBFqUQsE';
const appsScriptUrl = 'https://script.google.com/macros/s/AKfycbzXu77bmooy2cXFh7vCPr5BuGZ0N25ZknBdyo20agSCM5JzmnlIfWGReP1HX4O9RUmTsA/exec';

const google = new OAuth2Client(clientId);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}

async function deleteBooking(req, res) {
  if (!req.headers.host || req.headers.origin !== `https://${req.headers.host}`) {
    return sendJson(res, 403, { error: 'Delete must be requested from the CRM dashboard.' });
  }

  const bookingId = req.body?.booking_id;
  if (typeof bookingId !== 'string' ||
      !/^(?:BK|LEGACY)-[A-Za-z0-9_:-]{1,200}$/.test(bookingId)) {
    return sendJson(res, 400, { error: 'Invalid booking ID.' });
  }

  const secret = process.env.CRM_DELETE_SECRET;
  if (!secret) {
    return sendJson(res, 503, { error: 'Booking deletion is not configured.' });
  }

  try {
    const response = await fetch(appsScriptUrl, {
      method: 'POST',
      body: new URLSearchParams({
        action: 'delete',
        booking_id: bookingId,
        secret
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return sendJson(res, 502, { error: 'Could not confirm deletion. Refresh the booking list before retrying.' });
    }

    const result = await response.json();
    switch (result.status) {
      case 'deleted':
        return sendJson(res, 200, { status: 'deleted', booking_id: bookingId });
      case 'payments_exist':
        return sendJson(res, 409, {
          status: 'payments_exist',
          error: 'This booking has a payment record and was not deleted.'
        });
      case 'not_found':
        return sendJson(res, 404, { error: 'Booking not found. Refresh the booking list.' });
      case 'duplicate_id':
        return sendJson(res, 409, { error: 'This booking ID appears more than once in the Sheet.' });
      case 'busy':
        return sendJson(res, 503, { error: 'The Sheet is busy. Try again shortly.' });
      default:
        return sendJson(res, 502, { error: 'Apps Script could not confirm the deletion.' });
    }
  } catch {
    return sendJson(res, 502, { error: 'Could not confirm deletion. Refresh the booking list before retrying.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    res.statusCode = 405;
    return res.end();
  }

  const params = new URL(req.url, 'https://crm.invalid').searchParams;
  const wantsBookings = req.method === 'GET' && params.get('data') === 'bookings';
  const wantsDelete = req.method === 'POST' && params.get('action') === 'delete';
  const isLogin = req.method === 'POST' && !wantsDelete;

  const credential = isLogin
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

    if (!identity?.email_verified || identity.email !== allowedEmail) {
      throw new Error('Account not allowed');
    }
  } catch {
    if (wantsBookings || wantsDelete) {
      return sendJson(res, 401, { error: 'Please sign in again.' });
    }
    return res.redirect(303, '/?login=denied');
  }

  if (isLogin) {
    const remaining = Math.max(0, identity.exp - Math.floor(Date.now() / 1000));
    res.setHeader(
      'Set-Cookie',
      'baba_google=' + credential +
        '; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=' + remaining
    );
    return res.redirect(303, '/api/dashboard');
  }

  if (wantsDelete) return deleteBooking(req, res);

  if (wantsBookings) {
    try {
      const auth = new GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      });

      const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet`);
      url.searchParams.append('ranges', 'Bookings!A1:R');
      url.searchParams.append('ranges', 'Payments!A1:I');

      const sheets = await auth.getClient();
      const { data } = await sheets.request({ url: url.href, timeout: 10000 });
      return sendJson(res, 200, { valueRanges: data.valueRanges });
    } catch (error) {
      console.error('CRM Sheets read failed', error.response?.status ?? error.code ?? error.name);
      return sendJson(res, 502, { error: 'Could not load CRM bookings.' });
    }
  }

  const html = fs.readFileSync(path.join(process.cwd(), 'lib', 'dashboard.html'), 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
};
