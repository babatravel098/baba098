const fs = require('node:fs');
const path = require('node:path');
const { OAuth2Client } = require('google-auth-library');
const clientId = '679114631889-9r6mtbtm8el7t87s4e3m1aii2g0nj7gk.apps.googleusercontent.com';
const google = new OAuth2Client(clientId);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const credential = req.method === 'POST'
    ? req.body?.credential
    : /(?:^|;\s*)baba_google=([^;]+)/.exec(req.headers.cookie || '')?.[1];

  let identity;
  try {
    if (typeof credential !== 'string' || credential.length > 3500) throw new Error();
    identity = (await google.verifyIdToken({ idToken: credential, audience: clientId })).getPayload();
    if (!identity?.email_verified || identity.email !== 'babatourandtravel098@gmail.com') throw new Error();
  } catch {
    return res.redirect(303, '/?login=denied');
  }

  if (req.method === 'POST') {
    const remaining = Math.max(0, identity.exp - Math.floor(Date.now() / 1000));
    res.setHeader('Set-Cookie', 'baba_google=' + credential +
      '; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=' + remaining);
    return res.redirect(303, '/api/dashboard');
  }

  const html = fs.readFileSync(path.join(process.cwd(), 'lib', 'dashboard.html'), 'utf8');
 res.statusCode = 200;
res.setHeader('Content-Type', 'text/html; charset=utf-8');
return res.end(html);
};
