// scripts/google-oauth.js
// ---------------------------------------------------------------------------
// Autorización OAuth2 de UN SOLO USO para obtener el refresh token de Google
// Calendar (cuando la org bloquea keys de Service Account).
//
// Requisitos previos (en .env.development):
//   GOOGLE_OAUTH_CLIENT_ID=...       (del Client OAuth "App de escritorio" o "Web")
//   GOOGLE_OAUTH_CLIENT_SECRET=...
// Y en el Client OAuth, registra el redirect URI: http://localhost:5055/oauth2callback
//
// Uso:
//   cd implaeden_backend && node scripts/google-oauth.js
//   -> abre la URL que imprime (logueado como implaeden@gmail.com), autoriza,
//      y copia el GOOGLE_OAUTH_REFRESH_TOKEN que aparece en la terminal a .env.development
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.development') });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT = 'http://localhost:5055/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Faltan GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET en .env.development');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',        // necesario para recibir refresh_token
  prompt: 'consent',             // fuerza refresh_token aunque ya hayas autorizado antes
  scope: ['https://www.googleapis.com/auth/calendar'],
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) { res.end('Sin code'); return; }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Autorización completa. Vuelve a la terminal y cierra esta pestaña.');
    console.log('\n=== COPIA ESTO EN .env.development ===');
    if (tokens.refresh_token) {
      console.log('GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    } else {
      console.log('⚠️ No llegó refresh_token. Revoca el acceso en https://myaccount.google.com/permissions y reintenta (usa prompt=consent).');
    }
    console.log('======================================\n');
    server.close(() => process.exit(0));
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error(e);
    process.exit(1);
  }
});

server.listen(5055, () => {
  console.log('\n1) Asegúrate de haber registrado el redirect en el Client OAuth:');
  console.log('   ' + REDIRECT);
  console.log('\n2) Abre esta URL en el navegador (logueado como la cuenta dueña del calendario):\n');
  console.log('   ' + url + '\n');
});
