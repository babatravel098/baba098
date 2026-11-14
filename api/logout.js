module.exports = (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.setHeader('Set-Cookie', 'baba_google=; Path=/api/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  return res.redirect(303, '/');
};
