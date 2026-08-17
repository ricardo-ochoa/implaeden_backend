// scripts/googleRefreshToken.js
// ---------------------------------------------------------------------------
// Genera un GOOGLE_OAUTH_REFRESH_TOKEN nuevo para la integración con Google
// Calendar.
//
// ¿Por qué hace falta un script? Porque el refresh token NO se puede consultar
// en Google Cloud Console: Google lo entrega una sola vez, como respuesta al
// intercambio del código de autorización, y únicamente si se piden
// `access_type=offline` y `prompt=consent`. Si se pierde, no se recupera: hay
// que volver a autorizar.
//
// Uso (desde implaeden_backend/, con las credenciales en .env.development):
//
//   node scripts/googleRefreshToken.js
//
// Levanta un servidor local, abre la URL de consentimiento que imprime, y al
// autorizar recibe el código y muestra el refresh token.
//
// El puerto por defecto es 5055 porque ES EL QUE YA ESTÁ REGISTRADO en el
// cliente OAuth de la clínica ("Authorized redirect URIs" →
// http://localhost:5055/oauth2callback). Google exige coincidencia exacta:
// scheme, host, puerto y ruta. Si algún día se registra otro, se pasa con
// --port <n>, pero entonces hay que darlo de alta en la consola primero.
// ---------------------------------------------------------------------------
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

const args = process.argv.slice(2);
const flag = (nombre, porDefecto = null) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : porDefecto;
};

const PUERTO = Number(flag('port', 5055));
const RUTA_CALLBACK = '/oauth2callback';
const REDIRECT_URI = flag('redirect', `http://localhost:${PUERTO}${RUTA_CALLBACK}`);

if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
  const env = process.env.NODE_ENV || 'development';
  require('dotenv').config({ path: path.resolve(__dirname, '..', `.env.${env}`) });
}

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '\n✖ Faltan GOOGLE_OAUTH_CLIENT_ID y/o GOOGLE_OAUTH_CLIENT_SECRET.\n' +
      '  Ponlos en el .env correspondiente, o pásalos por variables de entorno.'
  );
  process.exit(1);
}

// El mismo scope que pide services/googleCalendar.js. Pedir de más obliga a
// re-autorizar sin necesidad.
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const url = oauth2.generateAuthUrl({
  // offline = queremos refresh token, no solo el access token.
  access_type: 'offline',
  // consent = fuerza a Google a emitir un refresh token NUEVO. Sin esto, si la
  // cuenta ya había autorizado antes, devuelve solo el access token y el script
  // termina sin lo que veníamos a buscar.
  prompt: 'consent',
  scope: SCOPES,
});

const servidor = http.createServer(async (req, res) => {
  if (!req.url.startsWith(RUTA_CALLBACK)) {
    res.writeHead(404).end('No es aquí.');
    return;
  }

  const params = new URL(req.url, `http://localhost:${PUERTO}`).searchParams;
  const error = params.get('error');
  const code = params.get('code');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Autorización cancelada</h2><p>${error}</p>`);
    console.error(`\n✖ Google devolvió: ${error}`);
    servidor.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<h2>Listo</h2><p>Ya puedes cerrar esta pestaña y volver a la terminal.</p>'
    );

    if (!tokens.refresh_token) {
      console.error(
        '\n✖ Google no devolvió refresh_token.\n' +
          '  Suele pasar cuando la cuenta ya tenía la app autorizada. Revoca el acceso en\n' +
          '  https://myaccount.google.com/permissions y vuelve a correr el script.'
      );
      servidor.close();
      process.exit(1);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('\n  Cópialo a:');
    console.log('   · dev  -> implaeden_backend/.env.development');
    console.log('   · prod -> infra/docker-compose.prod.yml (backend.environment)');
    console.log('            y luego "Update the stack" en Portainer.\n');
    console.log('  Trátalo como una contraseña: da acceso al calendario de la clínica.\n');

    servidor.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Falló el intercambio</h2><p>Revisa la terminal.</p>');
    console.error(`\n✖ No se pudo canjear el código: ${err?.message || err}`);
    if (String(err?.message || '').includes('redirect_uri_mismatch')) {
      console.error(
        `\n  El redirect URI no está registrado. Agrega EXACTAMENTE esto en\n` +
          `  Google Cloud Console → Credentials → tu OAuth Client ID → Authorized redirect URIs:\n` +
          `      ${REDIRECT_URI}`
      );
    }
    servidor.close();
    process.exit(1);
  }
});

// Sin esto, un puerto ocupado tumba el script con un "Unhandled 'error' event"
// y un stack de Node que no dice nada útil.
servidor.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n✖ El puerto ${PUERTO} ya está en uso.\n\n` +
        `  Cierra lo que lo esté ocupando (lsof -ti :${PUERTO}) y reintenta.\n` +
        `  Ojo: no basta con usar --port <otro>, porque el redirect URI tiene que\n` +
        `  estar registrado en Google Cloud Console y ahí solo está el ${PUERTO}.`
    );
  } else {
    console.error(`\n✖ No se pudo abrir el servidor local: ${err.message}`);
  }
  process.exit(1);
});

servidor.listen(PUERTO, () => {
  console.log('\nAutorización de Google Calendar');
  console.log(`  Redirect URI: ${REDIRECT_URI}`);
  console.log(`  Scope:        ${SCOPES.join(', ')}`);
  console.log('\n1) Abre esta URL en el navegador, con la cuenta dueña del calendario:\n');
  console.log(url);
  console.log('\n2) Autoriza. Al terminar, el token aparece aquí.\n');
  console.log('   (Ctrl+C para cancelar)');
});
