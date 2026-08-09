// services/googleCalendar.js
// ---------------------------------------------------------------------------
// Capa de servicio de Google Calendar (GCal = fuente de verdad de la agenda).
// Todo el mapeo evento <-> cita vive aquí; el resto de la app no llama a la API
// directamente.
//
// DISEÑO IMPORTANTE: inicialización LAZY y TOLERANTE. Si faltan las credenciales
// (GOOGLE_SERVICE_ACCOUNT_KEY / CLINIC_CALENDAR_ID), NO se cae la app al arrancar:
// los métodos lanzan un error con code 'GCAL_NOT_CONFIGURED' y las rutas
// responden 503. Así puedes desplegar el código antes de tener el setup de GCP.
// ---------------------------------------------------------------------------
const { google } = require('googleapis');

const CLINIC_TIME_ZONE = process.env.CLINIC_TIME_ZONE || 'America/Mexico_City';

function isConfigured() {
  const hasCalendar = Boolean(process.env.CLINIC_CALENDAR_ID);
  const hasOAuth = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  const hasServiceAccount = Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return hasCalendar && (hasOAuth || hasServiceAccount);
}

// Detecta el ORIGEN de un evento sin tener que tocar Confirmafy:
// - 'clinic-app': lo creó nuestra app (lleva la marca en extendedProperties).
// - 'confirmafy': la descripción trae la firma de Confirmafy.
// - 'manual': cualquier otro (se metió a mano en Google Calendar).
function detectSource(event, ep) {
  if (ep.source) return ep.source; // 'clinic-app' u otra marca nuestra
  const haystack = `${event.summary || ''} ${event.description || ''}`.toLowerCase();
  if (haystack.includes('confirmafy')) return 'confirmafy';
  return 'manual';
}

// Extrae el TELÉFONO del contacto (para reconciliar citas de Confirmafy).
// Fuente más confiable: el link de WhatsApp (phone=52XXXXXXXXXX o wa.me/52...).
// Devuelve los últimos 10 dígitos (formato local MX) o null.
function extractPhone(event) {
  const text = `${event.description || ''} ${event.summary || ''}`;
  let m = text.match(/[?&]phone=(\d{8,15})/i) || text.match(/wa\.me\/(\d{8,15})/i);
  let digits = m ? m[1] : '';
  if (!digits) {
    const m2 = text.match(/\+?52[\s-]?\d[\d\s-]{8,}/) || text.match(/\d[\d\s-]{8,}/);
    digits = m2 ? m2[0] : '';
  }
  digits = digits.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Extrae el/los EMOJI del inicio del título (Confirmafy antepone un círculo de
// color 🟢/🟡/🔴 según el estado del recordatorio). Sirve como pista visual de
// que la cita viene de Confirmafy. Devuelve el string de emoji o null.
function extractEmoji(event) {
  const s = String(event.summary || '');
  const m = s.match(/^\s*([\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍]+)/u);
  return m ? m[1].trim() : null;
}

// Extrae un NOMBRE best-effort del título (para sugerir por nombre).
function extractName(event) {
  let s = String(event.summary || '');
  s = s.replace(/[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  s = s.replace(/citas?\s+en\s+implaed[eé]n/gi, ' ');
  s = s.replace(/\+?\d[\d\s\-()]{6,}\d/g, ' ');   // teléfonos
  s = s.replace(/^\s*cita[:\s]*/i, ' ');           // prefijo "Cita"
  s = s.replace(/[-–|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

// -------- Mapeo evento -> cita (objeto que usa la app) --------
function eventToAppointment(event) {
  const ep = (event.extendedProperties && event.extendedProperties.private) || {};
  return {
    eventId: event.id,                                   // clave (la genera Google)
    patientId: ep.clinicPatientId ? Number(ep.clinicPatientId) : null,
    serviceId: ep.serviceId ? Number(ep.serviceId) : null,
    treatment: ep.serviceName || event.summary || null,  // nombre para mostrar
    observations: ep.observations || event.description || null,
    // status = estado clínico nuestro (no del evento). Si GCal marca el evento
    // como cancelado, lo reflejamos; si no, por defecto 'scheduled'.
    status: ep.status || (event.status === 'cancelled' ? 'cancelled' : 'scheduled'),
    source: detectSource(event, ep),                     // clinic-app | confirmafy | manual
    start: (event.start && (event.start.dateTime || event.start.date)) || null,
    end: (event.end && (event.end.dateTime || event.end.date)) || null,
    createdAt: event.created,
    updatedAt: event.updated,
    isLinked: Boolean(ep.clinicPatientId),               // ¿asignada a un paciente?
    contactPhone: ep.contactPhone || extractPhone(event), // guardado por nosotros o extraído (Confirmafy)
    contactName: ep.contactName || extractName(event),
    emoji: extractEmoji(event),                          // pista visual (Confirmafy antepone 🟢/🟡/🔴)
    raw: event,
  };
}

// Arma el título del evento. El TELÉFONO va al final porque Confirmafy lo lee
// del título para enviar el recordatorio por WhatsApp.
function buildTitle({ contactName, serviceName, contactPhone }) {
  let title;
  if (contactName) {
    title = contactName;
    if (serviceName) title += ` — ${serviceName}`;
  } else if (serviceName) {
    title = `Cita: ${serviceName}`;
  } else {
    title = 'Cita clínica';
  }
  if (contactPhone) title += ` - ${contactPhone}`;
  return title;
}

// -------- Mapeo cita -> cuerpo del evento (extendedProperties SOLO strings) --------
function appointmentToEventBody(appt, timeZone) {
  const title = buildTitle({
    contactName: appt.contactName,
    serviceName: appt.serviceName,
    contactPhone: appt.contactPhone,
  });
  const descParts = [];
  if (appt.observations) descParts.push(appt.observations);
  if (appt.contactPhone) descParts.push(`Tel/WhatsApp: ${appt.contactPhone}`);
  return {
    summary: title,
    description: descParts.join('\n'),
    start: { dateTime: appt.start, timeZone }, // appt.start en RFC3339
    end: { dateTime: appt.end, timeZone },
    extendedProperties: {
      private: {
        clinicPatientId: String(appt.patientId || ''),
        serviceId: String(appt.serviceId || ''),
        serviceName: String(appt.serviceName || ''),
        contactName: String(appt.contactName || ''),
        contactPhone: String(appt.contactPhone || ''),
        observations: String(appt.observations || ''),
        status: String(appt.status || 'scheduled'),
        source: 'clinic-app', // marca de origen (evita bucles de sync en Fase 3)
      },
    },
  };
}

// -------- Cliente perezoso --------
let _calendar = null;
let _calendarId = null;

function getClient() {
  if (!isConfigured()) {
    const err = new Error(
      'Google Calendar no está configurado (faltan GOOGLE_SERVICE_ACCOUNT_KEY o CLINIC_CALENDAR_ID).'
    );
    err.code = 'GCAL_NOT_CONFIGURED';
    throw err;
  }
  if (!_calendar) {
    let auth;
    if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      // OAuth2 (recomendado cuando la org bloquea keys de Service Account).
      // Autoriza a la propia cuenta dueña del calendario; googleapis renueva
      // el access token automáticamente con el refresh token.
      const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_OAUTH_CLIENT_ID,
        process.env.GOOGLE_OAUTH_CLIENT_SECRET
      );
      oauth2.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
      auth = oauth2;
    } else {
      // Service Account (solo si tu proyecto permite crear/usar keys).
      let credentials;
      try {
        credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      } catch (e) {
        const err = new Error('GOOGLE_SERVICE_ACCOUNT_KEY no es un JSON válido.');
        err.code = 'GCAL_BAD_KEY';
        throw err;
      }
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
    }
    _calendar = google.calendar({ version: 'v3', auth });
    _calendarId = process.env.CLINIC_CALENDAR_ID;
  }
  return { calendar: _calendar, calendarId: _calendarId, timeZone: CLINIC_TIME_ZONE };
}

// -------- Citas de UN paciente (filtra por extendedProperty) --------
async function listByPatient(patientId, { timeMin, timeMax } = {}) {
  const { calendar, calendarId } = getClient();
  const res = await calendar.events.list({
    calendarId,
    privateExtendedProperty: [`clinicPatientId=${patientId}`],
    timeMin,
    timeMax,
    singleEvents: true,   // expande recurrentes a instancias
    orderBy: 'startTime',
    maxResults: 250,
  });
  return (res.data.items || []).map(eventToAppointment);
}

// -------- Todas las citas en un rango (vista global de la clínica) --------
async function listRange({ timeMin, timeMax } = {}) {
  const { calendar, calendarId } = getClient();
  const res = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });
  return (res.data.items || []).map(eventToAppointment);
}

// -------- Crea una cita desde la app --------
async function create(appt) {
  const { calendar, calendarId, timeZone } = getClient();
  const res = await calendar.events.insert({
    calendarId,
    requestBody: appointmentToEventBody(appt, timeZone),
    sendUpdates: 'none',
  });
  return eventToAppointment(res.data);
}

// -------- Citas sin vincular (bandeja de reconciliación Confirmafy/manual) --------
async function listUnassigned({ timeMin, timeMax } = {}) {
  const all = await listRange({ timeMin, timeMax });
  return all.filter((a) => !a.isLinked);
}

// -------- Vincular un evento a un paciente (estampa clinicPatientId) --------
// No sobreescribe 'source': el origen (confirmafy/manual) se sigue detectando.
async function linkToPatient(eventId, patientId, extra = {}) {
  const { calendar, calendarId } = getClient();
  const priv = { clinicPatientId: String(patientId) };
  if (extra.serviceId) priv.serviceId = String(extra.serviceId);
  if (extra.serviceName) priv.serviceName = String(extra.serviceName);
  if (extra.status) priv.status = String(extra.status);
  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: { extendedProperties: { private: priv } },
  });
  return eventToAppointment(res.data);
}

// -------- Editar una cita (patch parcial) --------
async function update(eventId, changes = {}) {
  const { calendar, calendarId, timeZone } = getClient();

  const body = {};
  if (changes.start) body.start = { dateTime: changes.start, timeZone };
  if (changes.end) body.end = { dateTime: changes.end, timeZone };

  // Si cambia el tratamiento (o el contacto), reconstruimos el título SIN perder
  // nombre + teléfono (Confirmafy los necesita). Para eso leemos el evento actual
  // y, si no están en extendedProperties (citas de Confirmafy), los extraemos del título.
  const touchesTitle =
    changes.serviceName !== undefined ||
    changes.contactName !== undefined ||
    changes.contactPhone !== undefined;
  const touchesDesc = changes.observations !== undefined;

  if (touchesTitle || touchesDesc) {
    const cur = await calendar.events.get({ calendarId, eventId });
    const ep = (cur.data.extendedProperties && cur.data.extendedProperties.private) || {};
    const contactName = changes.contactName || ep.contactName || extractName(cur.data) || '';
    const contactPhone = changes.contactPhone || ep.contactPhone || extractPhone(cur.data) || '';
    const serviceName = changes.serviceName || ep.serviceName || '';
    const observations = changes.observations !== undefined ? changes.observations : (ep.observations || '');

    if (touchesTitle) body.summary = buildTitle({ contactName, serviceName, contactPhone });
    if (touchesDesc || contactPhone) {
      const parts = [];
      if (observations) parts.push(observations);
      if (contactPhone) parts.push(`Tel/WhatsApp: ${contactPhone}`);
      body.description = parts.join('\n');
    }
  }

  const priv = {};
  if (changes.serviceId !== undefined) priv.serviceId = String(changes.serviceId);
  if (changes.serviceName !== undefined) priv.serviceName = String(changes.serviceName);
  if (changes.contactName !== undefined) priv.contactName = String(changes.contactName);
  if (changes.contactPhone !== undefined) priv.contactPhone = String(changes.contactPhone);
  if (changes.observations !== undefined) priv.observations = String(changes.observations);
  if (changes.status !== undefined) priv.status = String(changes.status);
  if (Object.keys(priv).length) body.extendedProperties = { private: priv };

  const res = await calendar.events.patch({ calendarId, eventId, requestBody: body });
  return eventToAppointment(res.data);
}

// -------- Sync incremental (para el espejo local `appointments`) --------
// Devuelve eventos CRUDOS + nextSyncToken. Dos modos:
//   - con syncToken: trae SOLO lo que cambió desde el último sync (incluye
//     borrados, que llegan con status 'cancelled' gracias a showDeleted).
//   - sin syncToken (primer sync): trae desde `timeMin` y Google entrega el
//     nextSyncToken en la última página para arrancar los incrementales.
// Nota: con syncToken NO se pueden mandar timeMin/orderBy (Google lo rechaza);
// `singleEvents` debe ser consistente entre llamadas (siempre true aquí).
async function listEventsForSync({ syncToken, timeMin } = {}) {
  const { calendar, calendarId } = getClient();
  const items = [];
  let pageToken;
  let nextSyncToken;
  const base = { calendarId, singleEvents: true, maxResults: 2500 };
  if (syncToken) {
    base.syncToken = syncToken;
    base.showDeleted = true;
  } else if (timeMin) {
    base.timeMin = timeMin;
  }
  do {
    const res = await calendar.events.list({ ...base, pageToken });
    for (const e of res.data.items || []) items.push(e);
    nextSyncToken = res.data.nextSyncToken || nextSyncToken;
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return { items, nextSyncToken };
}

// -------- Eliminar una cita --------
async function remove(eventId) {
  const { calendar, calendarId } = getClient();
  await calendar.events.delete({ calendarId, eventId });
  return { deleted: true, eventId };
}

module.exports = {
  isConfigured,
  listByPatient,
  listRange,
  listUnassigned,
  create,
  linkToPatient,
  update,
  remove,
  listEventsForSync,
  eventToAppointment,
  appointmentToEventBody,
  extractPhone,
  extractName,
  CLINIC_TIME_ZONE,
};
