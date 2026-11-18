const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const clientId = '679114631889-9r6mtbtm8el7t87s4e3m1aii2g0nj7gk.apps.googleusercontent.com';
const allowedEmail = 'babatourandtravel098@gmail.com';
const sheetId = '1I6cFI9mU3z8EPc5cRxNZy25cj3E4sO6xVnXHBFqUQsE';
const appsScriptUrl = 'https://script.google.com/macros/s/AKfycbw4OfLzT9WCE4eQXPblPO1pu1br4U716qqIID_IBn3nsGjfBaE4etem0coCpY1tWUl5/exec';
const google = new OAuth2Client(clientId);
const readActions = new Map([
  ['tour-health', 'health'], ['tour-packages', 'listPackages'], ['tour-quotations', 'listQuotations']
]);
const writeActions = new Map([
  ['save-tour-package', 'savePackage'], ['save-tour-quotation', 'saveQuotation'],
  ['set-tour-quotation-status', 'setQuotationStatus']
]);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}
function isDashboardOrigin(req) {
  return Boolean(req.headers.host) && req.headers.origin === `https://${req.headers.host}`;
}
async function readBookingRanges(ranges) {
  const auth = new GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet`);
  for (const range of ranges) url.searchParams.append('ranges', range);
  const sheets = await auth.getClient();
  const {data} = await sheets.request({url: url.href, timeout: 10000});
  return data.valueRanges;
}

async function deleteBooking(req, res) {
  if (!isDashboardOrigin(req)) return sendJson(res, 403, {error: 'Delete must be requested from the CRM dashboard.'});
  const bookingId = req.body?.booking_id;
  if (typeof bookingId !== 'string' || !/^(?:BK|LEGACY)-[A-Za-z0-9_:-]{1,200}$/.test(bookingId)) {
    return sendJson(res, 400, {error: 'Invalid booking ID.'});
  }
  const secret = process.env.CRM_DELETE_SECRET;
  if (!secret) return sendJson(res, 503, {error: 'Booking deletion is not configured.'});
  const unconfirmed = {error: 'Could not confirm deletion. Refresh the booking list before retrying.'};
  try {
    const response = await fetch(appsScriptUrl, {
      method: 'POST',
      body: new URLSearchParams({action: 'delete', booking_id: bookingId, secret}),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return sendJson(res, 502, unconfirmed);
    const result = await response.json();
    switch (result.status) {
      case 'deleted': return sendJson(res, 200, {status: 'deleted', booking_id: bookingId});
      case 'not_found': return sendJson(res, 404, {error: 'Booking not found. Refresh the booking list.'});
      case 'duplicate_id': return sendJson(res, 409, {error: 'This booking ID appears more than once in the Sheet.'});
      case 'busy': return sendJson(res, 503, {error: 'The Sheet is busy. Try again shortly.'});
      case 'unauthorized': return sendJson(res, 502, {error: 'Apps Script rejected the Delete credentials.'});
      default: return sendJson(res, 502, {error: 'Apps Script could not confirm the deletion.'});
    }
  } catch {
    return sendJson(res, 502, unconfirmed);
  }
}

async function handleTourStorage(req, res, action) {
  const url = process.env.TOUR_API_URL;
  const secret = process.env.TOUR_API_SECRET;
  if (!url || !secret) return sendJson(res, 503, {error: 'Tour API variables are missing.'});
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    return sendJson(res, 503, {error: 'TOUR_API_URL must be an Apps Script /exec URL.'});
  }
  if (req.method === 'POST' && !isDashboardOrigin(req)) {
    return sendJson(res, 403, {error: 'Save must be requested from the CRM dashboard.'});
  }

  const payload = {action, secret};
  const recordKey = action === 'savePackage' ? 'package' : action === 'saveQuotation' ? 'quotation' : null;
  if (recordKey) {
    const record = req.body?.[recordKey];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return sendJson(res, 400, {error: `The ${recordKey} details are required.`});
    }
    payload[recordKey] = record;
  }

  try {
    if (action === 'setQuotationStatus') {
      const {id, status, bookingReference} = req.body || {};
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) ||
          !['Confirmed', 'Cancelled'].includes(status)) {
        return sendJson(res, 400, {error: 'Invalid quotation status.'});
      }
      if (status === 'Confirmed' && (typeof bookingReference !== 'string' ||
          !/^(?:BK|LEGACY)-[A-Za-z0-9_:-]{1,200}$/.test(bookingReference))) {
        return sendJson(res, 400, {error: 'A booking reference is required.'});
      }
      const [range] = await readBookingRanges(['Bookings!A1:R']);
      if (!Array.isArray(range?.values)) {
        return sendJson(res, 502, {error: 'Could not verify quotation bookings.'});
      }
      const marker = '[Nepal quote ' + id + ']';
      const matches = range.values.slice(1).filter(row => String(row[8] || '').includes(marker));
      if (status === 'Confirmed' && (matches.length !== 1 || String(matches[0][0]) !== bookingReference)) {
        return sendJson(res, 409, {error: 'The linked booking could not be verified.'});
      }
      if (status === 'Cancelled' && matches.length) {
        return sendJson(res, 409, {error: 'This quotation is linked to a booking.'});
      }
      Object.assign(payload, {id, status, bookingReference: status === 'Confirmed' ? bookingReference : ''});
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const result = response.ok ? await response.json() : null;
    if (result?.ok !== true) {
      const errors = new Map([
        ['Invalid package', 400], ['Package is too large', 400],
        ['Invalid quotation', 400], ['Quotation is too large', 400],
        ['Invalid quotation status', 400], ['Quotation not found', 404],
        ['Quotation is no longer pending', 409]
      ]);
      const status = errors.get(result?.error);
      if (status) return sendJson(res, status, {error: result.error});
      const error = action === 'health' ? 'Tour Sheet connection check failed.' : 'Tour storage request failed.';
      return sendJson(res, 502, {error});
    }

    const listKey = action === 'listPackages' ? 'packages' : action === 'listQuotations' ? 'quotations' : null;
    if (listKey) {
      if (!Array.isArray(result[listKey])) return sendJson(res, 502, {error: `Tour storage returned an invalid ${listKey} list.`});
      return sendJson(res, 200, {ok: true, [listKey]: result[listKey]});
    }
    if (recordKey) {
      if (result.id !== payload[recordKey].id) {
        return sendJson(res, 502, {error: `Tour storage could not confirm the saved ${recordKey}.`});
      }
      return sendJson(res, 200, {ok: true, id: result.id});
    }
    if (action === 'setQuotationStatus') {
      if (result.id !== payload.id || result.status !== payload.status ||
          result.bookingReference !== payload.bookingReference) {
        return sendJson(res, 502, {error: 'Tour storage could not confirm the status.'});
      }
      return sendJson(res, 200, {ok: true, id: result.id, status: result.status, bookingReference: result.bookingReference});
    }
    return sendJson(res, 200, {ok: true});
  } catch {
    return sendJson(res, 502, {error: 'Could not complete the Tour Sheet request.'});
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
  const data = params.get('data');
  const action = params.get('action');
  const wantsBookings = req.method === 'GET' && data === 'bookings';
  const wantsDelete = req.method === 'POST' && action === 'delete';
  const tourAction = req.method === 'GET' ? readActions.get(data) : writeActions.get(action);
  const isLogin = req.method === 'POST' && !wantsDelete && !tourAction;
  const credential = isLogin ? req.body?.credential
    : /(?:^|;\s*)baba_google=([^;]+)/.exec(req.headers.cookie || '')?.[1];

  let identity;
  try {
    if (typeof credential !== 'string' || credential.length > 3500) throw new Error('Invalid credential');
    const ticket = await google.verifyIdToken({idToken: credential, audience: clientId});
    identity = ticket.getPayload();
    if (!identity?.email_verified || identity.email !== allowedEmail) throw new Error('Account not allowed');
  } catch {
    if (wantsBookings || wantsDelete || tourAction) return sendJson(res, 401, {error: 'Please sign in again.'});
    return res.redirect(303, '/?login=denied');
  }

  if (isLogin) {
    const remaining = Math.max(0, identity.exp - Math.floor(Date.now() / 1000));
    res.setHeader('Set-Cookie', 'baba_google=' + credential +
      '; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=' + remaining);
    return res.redirect(303, '/api/dashboard');
  }
  if (wantsDelete) return deleteBooking(req, res);
  if (tourAction) return handleTourStorage(req, res, tourAction);
  if (wantsBookings) {
    try {
      const valueRanges = await readBookingRanges(['Bookings!A1:R', 'Payments!A1:I']);
      return sendJson(res, 200, {valueRanges});
    } catch (error) {
      console.error('CRM Sheets read failed', error.response?.status ?? error.code ?? error.name);
      return sendJson(res, 502, {error: 'Could not load CRM bookings.'});
    }
  }
  const html = fs.readFileSync(path.join(process.cwd(), 'lib', 'dashboard.html'), 'utf8');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(html);
};
