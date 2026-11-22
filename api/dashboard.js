const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const clientId = '679114631889-9r6mtbtm8el7t87s4e3m1aii2g0nj7gk.apps.googleusercontent.com';
const allowedEmail = 'babatourandtravel098@gmail.com';
const sheetId = '1I6cFI9mU3z8EPc5cRxNZy25cj3E4sO6xVnXHBFqUQsE';
const appsScriptUrl = 'https://script.google.com/macros/s/AKfycbw4OfLzT9WCE4eQXPblPO1pu1br4U716qqIID_IBn3nsGjfBaE4etem0coCpY1tWUl5/exec';
const google = new OAuth2Client(clientId);
const readActions = new Map([
  ['fleet-register','fleetList'],
  ['gst-invoices', 'listGstInvoices'], ['tour-health', 'health'], ['tour-packages', 'listPackages'], ['tour-quotations', 'listQuotations'], ['tour-photos', 'listPhotos'], ['tour-photo', 'getPhoto'], ['tour-hotels', 'listHotels'], ['tour-vehicles', 'listVehicles']
]);
const writeActions = new Map([
  ['save-fleet-entry','fleetSave'],
  ['save-quotation-followup','setQuotationFollowup'], ['save-booking-payment', 'saveBookingPayment'], ['save-gst-invoice', 'saveGstInvoice'], ['cancel-gst-invoice', 'cancelGstInvoice'], ['save-tour-package', 'savePackage'], ['save-tour-quotation', 'saveQuotation'],
  ['set-tour-quotation-status', 'setQuotationStatus'], ['save-tour-photo', 'savePhoto'], ['save-tour-hotel', 'saveHotel'], ['save-tour-vehicle', 'saveVehicle'], ['delete-tour-package', 'deletePackage'], ['delete-tour-photo', 'deletePhoto']
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


// A daily session is independent of the short-lived Google ID token.
function sessionKey() {
  const key = process.env.CRM_SESSION_SECRET || JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}').private_key;
  if (typeof key !== 'string' || key.length < 32) throw new Error('Session signing is not configured');
  return crypto.createHmac('sha256', key).update('baba-crm-daily-session-v1').digest();
}
function dailyExpiry(now = Date.now()) {
  const day = 86400000, offset = 19800000;
  return Math.floor(((Math.floor((now + offset) / day) + 1) * day - offset) / 1000);
}
function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return encoded + '.' + crypto.createHmac('sha256', sessionKey()).update(encoded).digest('base64url');
}
function readSession(token) {
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid session');
  const expected = crypto.createHmac('sha256', sessionKey()).update(parts[0]).digest();
  const received = Buffer.from(parts[1], 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Invalid signature');
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (payload.email !== allowedEmail || !Number.isInteger(payload.exp) || payload.exp <= now ||
      payload.exp > dailyExpiry() || !Number.isInteger(payload.iat) || payload.iat > now || now - payload.iat > 86400) throw new Error('Expired session');
  return payload;
}
function setDailyCookie(res) {
  const now = Math.floor(Date.now() / 1000), exp = dailyExpiry();
  const token = signSession({email: allowedEmail, iat: now, exp});
  res.setHeader('Set-Cookie', 'baba_google=' + token + '; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=' + (exp - now));
}
function bookingVersion(row) {
  return crypto.createHash('sha256').update(JSON.stringify(Array.from({length: 18}, (_, i) => String(row[i] ?? '')))).digest('hex');
}
async function updateBooking(req, res) {
  if (!isDashboardOrigin(req)) return sendJson(res, 403, {error: 'Save must be requested from the CRM dashboard.'});
  const {booking_id: id, version, values} = req.body || {};
  if (typeof id !== 'string' || !/^(?:BK|LEGACY)-[A-Za-z0-9_:-]{1,200}$/.test(id) ||
      typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version) || !values || typeof values !== 'object') {
    return sendJson(res, 400, {error: 'Invalid booking update. Refresh bookings and reopen Edit Booking.'});
  }
  const keys = ['name', 'phone', 'address', 'staff', 'pickup', 'drop', 'tourRoute', 'startDate', 'endDate', 'vehicle'];
  if (keys.some(key => typeof values[key] !== 'string' || values[key].length > 4000) ||
      ['name', 'phone', 'pickup', 'drop', 'vehicle'].some(key => !values[key].trim()) ||
      !/^[+\d\s()-]{7,20}$/.test(values.phone) ||
      ![values.startDate, values.endDate].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value) ||
      values.endDate < values.startDate || typeof values.total !== 'number' || !Number.isFinite(values.total) || values.total < 0 || values.total > 1000000000) {
    return sendJson(res, 400, {error: 'Check customer, dates, vehicle and total amount.'});
  }
  try {
    const ranges = await readBookingRanges(['Bookings!A1:R', 'Payments!A1:I']);
    const rows = ranges[0]?.values || [], payments = ranges[1]?.values || [];
    if (rows[0]?.[0] !== 'booking_id' || payments[0]?.[1] !== 'booking_id') throw new Error('Unexpected headers');
    const matches = rows.map((row, index) => ({row, index})).filter(item => item.index > 0 && item.row[0] === id);
    if (matches.length !== 1) return sendJson(res, matches.length ? 409 : 404, {error: 'Booking could not be uniquely identified. Refresh the list.'});
    const {row, index} = matches[0];
    if (bookingVersion(row) !== version) return sendJson(res, 409, {error: 'This booking changed after you opened it. Your edits are retained. Refresh and review before saving again.'});
    const paid = payments.slice(1).filter(p => p[1] === id).reduce((sum, p) => sum + Math.round((Number(String(p[3] ?? '').replace(/[,\s₹]/g, '')) || 0) * 100), 0);
    if (Math.round(values.total * 100) < paid) return sendJson(res, 400, {error: 'Total cannot be below the payments already received.'});
    const marker = String(row[8] || '').match(/\[Nepal quote [^\]]+\]/g) || [];
    let route = values.tourRoute.trim();
    for (const item of marker) if (!route.includes(item)) route += ' ' + item;
    const saved = keys.map(key => key === 'tourRoute' ? route.trim() : values[key].trim());
    saved.push(Math.round(values.total * 100) / 100);
    const auth = new GoogleAuth({credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ['https://www.googleapis.com/auth/spreadsheets']});
    const client = await auth.getClient();
    // Only C:M are edited. Booking identity, status, payment ledger and other columns stay intact.
    const {data} = await client.request({url: 'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values:batchUpdate', method: 'POST', timeout: 15000,
      data: {valueInputOption: 'RAW', includeValuesInResponse: true, responseValueRenderOption: 'UNFORMATTED_VALUE', data: [{range: 'Bookings!C' + (index + 1) + ':M' + (index + 1), values: [saved]}]}});
    const actual = data.responses?.[0]?.updatedData?.values?.[0];
    if (!actual || JSON.stringify(actual) !== JSON.stringify(saved)) throw new Error('Save not confirmed');
    return sendJson(res, 200, {ok: true, booking_id: id});
  } catch (error) {
    const forbidden = error.response?.status === 403;
    return sendJson(res, forbidden ? 403 : 502, {error: forbidden ? 'Booking Sheet permission denied. Give the CRM service account Editor access to the booking Sheet.' : 'Could not confirm the booking save. Your edits are retained. Refresh the booking list before retrying.'});
  }
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

async function handleFleetRegister(req,res,action) {
  const write=action==='fleetSave';
  if(write&&!isDashboardOrigin(req))return sendJson(res,403,{error:'Save from the CRM dashboard.'});
  const url=process.env.TOUR_API_URL,secret=process.env.TOUR_API_SECRET;
  if(!secret||!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url||''))return sendJson(res,503,{error:'Check the Tour API deployment settings.'});
  const payload={action,secret};
  if(write){
    const {id,revision,entry}=req.body||{};
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||typeof revision!=='string'||revision.length>80||
       !entry||typeof entry!=='object'||Array.isArray(entry)||JSON.stringify(entry).length>5000)return sendJson(res,400,{error:'Invalid fleet entry.'});
    if(entry.kind==='Vehicle'){
      const hasDate=Boolean(entry.serviceDate),hasKm=entry.serviceKm!=null&&entry.serviceKm!=='';
      if(hasDate!==hasKm)return sendJson(res,400,{error:'For a previous service, enter both the service date and the odometer reading.'});
      if(hasDate&&entry.serviceDate>entry.date)return sendJson(res,400,{error:'A service after tracking began belongs in Record service.'});
      if(hasKm&&Number(entry.serviceKm)>Number(entry.km))return sendJson(res,400,{error:'Last service odometer exceeds opening km. Check both readings. For service done after opening, use Record service.'});
    }
    Object.assign(payload,{id,revision,entry});
  }else{
    payload.reg=new URL(req.url,'https://crm.invalid').searchParams.get('reg')||'';
    if(payload.reg&&!/^[A-Z0-9]{4,16}$/.test(payload.reg))return sendJson(res,400,{error:'Invalid vehicle number.'});
  }
  try{
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
    if(!response.ok)return sendJson(res,502,{error:'Apps Script returned HTTP '+response.status+'. Refresh the register to check the entry.'});
    const result=await response.json();
    if(result?.ok!==true){
      if(typeof result?.error==='string'&&result.error.startsWith('Fleet: ')&&result.error.length<=220)return sendJson(res,409,{error:result.error.slice(7)});
      if(result?.error==='Unknown action')return sendJson(res,502,{error:'The configured Apps Script deployment does not recognize the fleet action. Check its deployed version.'});
      if(result?.error==='Unauthorized')return sendJson(res,502,{error:'Apps Script rejected the CRM connection. Check the deployment settings.'});
      throw Error('Unconfirmed');
    }
    if(write){
      if(result.id!==payload.id||result.reg!==payload.entry.reg)throw Error('Unconfirmed');
      return sendJson(res,200,{ok:true,id:result.id,reg:result.reg});
    }
    if(!Array.isArray(result.vehicles)||!Array.isArray(result.history)||!Array.isArray(result.days)||!/^\d{4}-\d\d-\d\d$/.test(result.today))throw Error('Invalid list');
    return sendJson(res,200,{ok:true,today:result.today,vehicles:result.vehicles,history:result.history,days:result.days});
  }catch{
    return sendJson(res,502,{error:write?'Fleet save not confirmed. Retry the same entry.':'Fleet Sheet could not be loaded. Check the Apps Script deployment.'});
  }
}

async function handleTourStorage(req, res, action) {
  if(action==='fleetList'||action==='fleetSave')return handleFleetRegister(req,res,action);
  if(action==='saveBookingPayment')return handleBookingPayment(req,res);
  if (['listGstInvoices','saveGstInvoice','cancelGstInvoice'].includes(action)) return handleGstStorage(req,res,action);
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
  if(action==='setQuotationFollowup'){payload.id=req.body?.id;payload.followup=req.body?.followup;}
  const deleting = action === 'deletePackage' || action === 'deletePhoto';
  if (deleting) {
    const id = req.body?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return sendJson(res, 400, {error: 'Invalid item ID.'});
    }
    payload.id = id;
  }
  const recordKey = action === 'savePackage' ? 'package' : action === 'saveQuotation' ? 'quotation' : action === 'savePhoto' ? 'photo' : action === 'saveHotel' ? 'hotel' : action === 'saveVehicle' ? 'vehicle' : null;
  if (recordKey) {
    const record = req.body?.[recordKey];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return sendJson(res, 400, {error: `The ${recordKey} details are required.`});
    }
    payload[recordKey] = record;
  }

  if (action === 'getPhoto') {
    const id = new URL(req.url, 'https://crm.invalid').searchParams.get('id');
    if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return sendJson(res, 400, {error: 'Invalid photo ID.'});
    }
    payload.id = id;
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
        ['Invalid follow-up',400], ['Invalid item ID', 400], ['Photo is in use by a saved package or quotation', 409], ['Invalid hotel', 400], ['Invalid vehicle', 400], ['Invalid photo', 400], ['Photo not found', 404], ['Invalid package', 400], ['Package is too large', 400],
        ['Invalid quotation', 400], ['Quotation is too large', 400],
        ['Invalid quotation status', 400], ['Quotation not found', 404],
        ['Quotation is no longer pending', 409]
      ]);
      const status = errors.get(result?.error);
      if (status) return sendJson(res, status, {error: result.error});
      const error = action === 'health' ? 'Tour Sheet connection check failed.' : 'Tour storage request failed.';
      return sendJson(res, 502, {error});
    }

    if (deleting) {
      if (result.id !== payload.id) return sendJson(res, 502, {error: 'Delete could not be confirmed.'});
      return sendJson(res, 200, {ok: true, id: result.id});
    }
    if (action === 'setQuotationFollowup') {
      const saved = result.followup;
      const requested = payload.followup;
      if (!saved || !requested || typeof result.id !== 'string' || result.id !== payload.id ||
          saved.date !== requested.date || saved.note !== requested.note || saved.status !== requested.status) {
        return sendJson(res, 502, {error: 'Could not confirm this follow-up. Refresh and check the quotation.'});
      }
      const {date, note, status, updatedAt} = saved;
      return sendJson(res, 200, {ok: true, id: result.id, followup: {date, note, status, updatedAt}});
    }
    const listKey = action === 'listPackages' ? 'packages' : action === 'listQuotations' ? 'quotations' : action === 'listPhotos' ? 'photos' : action === 'listHotels' ? 'hotels' : action === 'listVehicles' ? 'vehicles' : null;
    if (action === 'getPhoto') {
      const photo = result.photo;
      if (!photo || photo.id !== payload.id ||
          typeof photo.data !== 'string' || !photo.data.startsWith('data:image/jpeg;base64,')) {
        return sendJson(res, 502, {error: 'Tour storage returned an invalid photo.'});
      }
      return sendJson(res, 200, {ok: true, photo});
    }
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


async function handleGstStorage(req,res,action) {
 if(req.method==='POST'&&!isDashboardOrigin(req))return sendJson(res,403,{error:'Open billing from the CRM dashboard.'});
 const secret=process.env.TOUR_API_SECRET, url=process.env.TOUR_API_URL;
 if(!secret||!url)return sendJson(res,503,{error:'Shared storage is not configured.'});
 const body=req.body||{};
 const payload={action,secret};
 if(action==='saveGstInvoice') {
  if(!body.invoice||typeof body.invoice!=='object'||JSON.stringify(body.invoice).length>40000)return sendJson(res,400,{error:'Invoice details are required and must be under 40 KB.'});
  payload.invoice=body.invoice;
 }
 if(action==='cancelGstInvoice')Object.assign(payload,{id:body.id,version:body.version,reason:body.reason});
 try {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  const result=response.ok?await response.json():null;
  if(!result?.ok) {
   const message=typeof result?.error==='string'?result.error:'Could not confirm invoice save. Keep this form open and retry.';
   return sendJson(res,502,{error:message});
  }
  if(action==='listGstInvoices') {
   if(!Array.isArray(result.invoices))throw Error('Invalid list');
   return sendJson(res,200,{ok:true,invoices:result.invoices});
  }
  const id=action==='saveGstInvoice'?body.invoice.id:body.id;
  if(result.invoice?.id!==id||!result.invoice.invoiceNo||!result.invoice.version)throw Error('Invalid response');
  return sendJson(res,200,{ok:true,invoice:result.invoice});
 } catch {return sendJson(res,502,{error:'Could not confirm invoice save. Keep this form open and retry with the same invoice.'});}
}

// Authenticated Appyflow lookup. Secret stays server-side and is sent in the POST body.
const gstLookupCache = new Map();
const gstLookupPending = new Map();
const gstLookupBudget = {start: 0, count: 0};
async function lookupGstin(req,res) {
 if(!isDashboardOrigin(req))return sendJson(res,403,{error:'Use GST lookup from the CRM dashboard.'});
 const gstin=typeof req.body?.gstin==='string'?req.body.gstin.trim().toUpperCase():'';
 if(!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))return sendJson(res,400,{error:'Enter a valid 15-character GSTIN.'});
 const secret=process.env.APPYFLOW_GST_API_SECRET?.trim();
 if(!secret)return sendJson(res,503,{error:'GST lookup key is not configured for this deployment.'});
 const cacheKey=crypto.createHash('sha256').update(secret).digest('hex').slice(0,16)+':'+gstin;
 const cached=gstLookupCache.get(cacheKey);
 if(cached&&cached.expires>Date.now())return sendJson(res,200,{ok:true,customer:cached.customer,cached:true});
 try {
  let pending=gstLookupPending.get(cacheKey);
  if(!pending) {
   const now=Date.now();
   if(now-gstLookupBudget.start>60000){gstLookupBudget.start=now;gstLookupBudget.count=0;}
   if(gstLookupBudget.count>=10)return sendJson(res,429,{error:'Too many GST lookups. Wait one minute before retrying.'});
   gstLookupBudget.count++;
   pending=fetchGstCustomer(gstin,secret);
   gstLookupPending.set(cacheKey,pending);
  }
  const customer=await pending;
  if(gstLookupCache.size>=64)gstLookupCache.delete(gstLookupCache.keys().next().value);
  gstLookupCache.set(cacheKey,{customer,expires:Date.now()+15*60*1000});
  return sendJson(res,200,{ok:true,customer,cached:false});
 }catch(error){return sendJson(res,error.gstStatus||502,{error:error.gstMessage||'GST lookup is unavailable. Retry later or enter the verified details manually.'});}
 finally{gstLookupPending.delete(cacheKey);}
}
function gstLookupFailure(status,message){const error=new Error('GST lookup failed');error.gstStatus=status;error.gstMessage=message;return error;}
async function fetchGstCustomer(gstin,secret) {
 const response=await fetch('https://appyflow.in/api/verifyGST',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gstNo:gstin,key_secret:secret}),signal:AbortSignal.timeout(15000),redirect:'error'
 });
 if(response.status===401||response.status===403)throw gstLookupFailure(502,'GST lookup credentials were rejected. Check the Vercel key.');
 if(response.status===429)throw gstLookupFailure(429,'GST lookup limit reached. Retry later.');
 if(!response.ok)throw gstLookupFailure(502,'GST provider is unavailable. Retry later.');
 const result=await response.json();
 if(result?.error) {
  const message=String(result.message||'').toLowerCase();
  if(/credit|balance|quota|recharge|limit/.test(message))throw gstLookupFailure(503,'GST lookup credits are unavailable. Check your Appyflow dashboard.');
  if(/key|secret|unauthor/.test(message))throw gstLookupFailure(502,'GST lookup credentials were rejected. Check the Vercel key.');
  if(/not found|invalid gst|no record/.test(message))throw gstLookupFailure(404,'No taxpayer details were found for this GSTIN.');
  throw gstLookupFailure(502,'GST provider could not verify this GSTIN. Check the number or retry later.');
 }
 const info=gstTaxpayerInfo(result);
 const returnedGstin=typeof info?.gstin==='string'?info.gstin.trim().toUpperCase():'';
 if(!returnedGstin)throw gstLookupFailure(502,'GST provider did not return a taxpayer GSTIN. No details were filled. Please retry later or check with Appyflow support.');
 if(returnedGstin!==gstin) {
  const safeNumber=/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(returnedGstin)?' Requested '+gstin+'; provider returned '+returnedGstin+'.':'';
  throw gstLookupFailure(502,'GST provider returned mismatched details.'+safeNumber+' Nothing was filled. Please check with Appyflow support.');
 }
 const clean=value=>typeof value==='string'?value.trim().slice(0,300):'';
 const legalName=clean(info.lgnm),tradeName=clean(info.tradeNam),address=info.pradr?.addr;
 if(!legalName&&!tradeName)throw gstLookupFailure(502,'GST provider returned incomplete customer details.');
 let formattedAddress='';
 if(address&&typeof address==='object') {
  const pieces=[address.bno,address.flno,address.bnm,address.st,address.loc,address.city,address.dst,address.stcd,address.pncd].map(clean).filter(Boolean);
  formattedAddress=Array.from(new Set(pieces)).join(', ');
 }
 return {gstin,legalName,tradeName,customerName:legalName||tradeName,customerAddress:formattedAddress.slice(0,500),stateCode:gstin.slice(0,2),stateName:clean(address?.stcd),status:clean(info.sts)||'Not provided',registrationDate:clean(info.rgdt),taxpayerType:clean(info.dty),source:'Appyflow',fetchedAt:new Date().toISOString()};
}

// Accept only bounded response envelopes. Identity always comes from the taxpayer record.
function gstTaxpayerInfo(result) {
 const decode=value=>{
  if(typeof value!=='string')return value;
  if(value.length>200000)return null;
  try{return JSON.parse(value);}catch{return null;}
 };
 let current=decode(result);
 for(let depth=0;depth<4;depth++) {
  if(!current||typeof current!=='object'||Array.isArray(current))return null;
  const info=decode(current.taxpayerInfo);
  if(info&&typeof info==='object'&&!Array.isArray(info))return info;
  if(typeof current.gstin==='string'&&(typeof current.lgnm==='string'||typeof current.tradeNam==='string'))return current;
  // Only unwrap one unambiguous conventional envelope; never search arbitrary objects.
  const envelopes=['data','result','response'].filter(key=>current[key]!=null);
  if(envelopes.length!==1)return null;
  current=decode(current[envelopes[0]]);
 }
 return null;
}


async function handleBookingPayment(req,res) {
 if(!isDashboardOrigin(req))return sendJson(res,403,{error:'Use Add Payment from the CRM dashboard.'});
 const body=req.body||{};
 if(!body.payment||typeof body.payment!=='object'||JSON.stringify(body).length>4000)return sendJson(res,400,{error:'Invalid payment request.'});
 const url=process.env.TOUR_API_URL,secret=process.env.TOUR_API_SECRET;
 if(!url||!secret||!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url))return sendJson(res,503,{error:'Payment storage is not configured.'});
 try {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'saveBookingPayment',secret,booking_id:body.booking_id,payment:body.payment,expectedReceived:body.expectedReceived,expectedTotal:body.expectedTotal}),signal:AbortSignal.timeout(25000)});
  const result=response.ok?await response.json():null;
  const known=['Invalid payment request','Invalid payment amount','Invalid payment date','Invalid payment details','Booking payment tabs not found','Booking payment headers differ','Booking could not be uniquely identified','Payment ID already used for different details','Booking payments changed. Refresh and review before saving','Payment exceeds the remaining booking balance'];
  if(result?.ok!==true)return sendJson(res,known.includes(result?.error)?409:502,{error:known.includes(result?.error)?result.error:'Could not confirm payment save. Keep this form open and retry the same payment. Check Apps Script deployment and booking Sheet access.'});
  if(result.payment_id!==body.payment.id||result.booking_id!==body.booking_id||!Number.isSafeInteger(result.received))throw Error('Unconfirmed');
  res.setHeader('Cache-Control','no-store');return sendJson(res,200,result);
 }catch{return sendJson(res,502,{error:'Could not confirm payment save. Keep this form open and retry the same payment; do not create another payment.'});}
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
  const wantsUpdate = req.method === 'POST' && action === 'update-booking';
  const wantsGstLookup = req.method === 'POST' && action === 'lookup-gstin';
  const isLogin = req.method === 'POST' && !action;
  if (req.method === 'POST' && !isLogin && !wantsDelete && !wantsUpdate && !wantsGstLookup && !tourAction) return sendJson(res, 400, {error: 'Unknown action.'});
  const credential = isLogin ? req.body?.credential
    : /(?:^|;\s*)baba_google=([^;]+)/.exec(req.headers.cookie || '')?.[1];

  try {
    if (typeof credential !== 'string' || credential.length > 3500) throw new Error('Invalid credential');
    if (!isLogin && credential.split('.').length === 2) {
      readSession(credential);
    } else {
      const ticket = await google.verifyIdToken({idToken: credential, audience: clientId});
      const identity = ticket.getPayload();
      if (!identity?.email_verified || identity.email !== allowedEmail) throw new Error('Account not allowed');
      setDailyCookie(res);
    }
  } catch {
    if (wantsBookings || wantsDelete || wantsUpdate || wantsGstLookup || tourAction) return sendJson(res, 401, {error: 'Please sign in again. Your unsaved form is still open.'});
    return res.redirect(303, '/?login=denied');
  }
  if (isLogin) return res.redirect(303, '/api/dashboard');
  if (wantsGstLookup) return lookupGstin(req,res);
  if (wantsUpdate) return updateBooking(req, res);
  if (wantsDelete) return deleteBooking(req, res);
  if (tourAction) return handleTourStorage(req, res, tourAction);
  if (wantsBookings) {
    res.setHeader('Cache-Control','no-store');
    try {
      const valueRanges = await readBookingRanges(['Bookings!A1:R', 'Payments!A1:I']);
      return sendJson(res, 200, {valueRanges, bookingVersions: Object.fromEntries((valueRanges[0]?.values || []).slice(1).map(row => [row[0], bookingVersion(row)]))});
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
