// services/appointmentsSync.js
// ---------------------------------------------------------------------------
// Sincroniza el espejo local `appointments` (MySQL) desde Google Calendar.
// GCal es la FUENTE DE VERDAD; esto es un read-model para consultas rápidas.
//
// Estrategia (forward-only, sin dependencias nuevas):
//   - 1er sync: lista desde (hoy - GCAL_SYNC_BACKFILL_MONTHS) y guarda el
//     nextSyncToken en `gcal_sync_state`.
//   - Syncs siguientes: usa el syncToken → solo cambios (incluye borrados, que
//     llegan con status 'cancelled' → los quitamos del espejo).
//   - Si el token expira (410 GONE), hace resync completo automáticamente.
//
// Reutiliza gcal.eventToAppointment para mapear (mismo shape que la API en vivo),
// así el espejo queda consistente con lo que ya conocen las rutas.
// ---------------------------------------------------------------------------
const pool = require('../config/db');
const gcal = require('./googleCalendar');

const BACKFILL_MONTHS = Number(process.env.GCAL_SYNC_BACKFILL_MONTHS || 18);

// ISO (con offset) -> 'YYYY-MM-DD HH:MM:SS' en UTC para DATETIME comparables.
function toUtcDatetime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function backfillTimeMin() {
  const ms = BACKFILL_MONTHS * 30 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - ms).toISOString();
}

async function getSyncToken(conn) {
  const [rows] = await conn.query('SELECT sync_token FROM gcal_sync_state WHERE id = 1');
  return rows[0] ? rows[0].sync_token : null;
}

async function saveSyncToken(conn, token, status) {
  await conn.query(
    `INSERT INTO gcal_sync_state (id, sync_token, last_synced_at, last_status)
     VALUES (1, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       sync_token = VALUES(sync_token),
       last_synced_at = NOW(),
       last_status = VALUES(last_status)`,
    [token || null, (status || '').slice(0, 240)]
  );
}

async function upsertEvent(conn, ev) {
  const a = gcal.eventToAppointment(ev);
  // Evento borrado/cancelado a nivel Google → fuera del read-model de citas activas.
  if (ev.status === 'cancelled') {
    await conn.query('DELETE FROM appointments WHERE event_id = ?', [a.eventId]);
    return;
  }
  await conn.query(
    `INSERT INTO appointments
       (event_id, patient_id, service_id, treatment, observations, status, source,
        contact_name, contact_phone, emoji, is_linked, start_at, end_at, start_iso, end_iso, etag, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       patient_id = VALUES(patient_id), service_id = VALUES(service_id), treatment = VALUES(treatment),
       observations = VALUES(observations), status = VALUES(status), source = VALUES(source),
       contact_name = VALUES(contact_name), contact_phone = VALUES(contact_phone), emoji = VALUES(emoji),
       is_linked = VALUES(is_linked), start_at = VALUES(start_at), end_at = VALUES(end_at),
       start_iso = VALUES(start_iso), end_iso = VALUES(end_iso), etag = VALUES(etag), raw = VALUES(raw)`,
    [
      a.eventId, a.patientId, a.serviceId, a.treatment, a.observations, a.status, a.source,
      a.contactName, a.contactPhone, a.emoji, a.isLinked ? 1 : 0,
      toUtcDatetime(a.start), toUtcDatetime(a.end), a.start || null, a.end || null,
      ev.etag || null, JSON.stringify(ev),
    ]
  );
}

let running = false;

// Corre una pasada de sincronización. `force:true` ignora el syncToken (resync
// completo). Devuelve un pequeño resumen; nunca lanza si GCal no está configurado.
async function syncAppointments({ force = false } = {}) {
  if (!gcal.isConfigured()) return { skipped: 'not_configured' };
  if (running) return { skipped: 'already_running' };
  running = true;

  const conn = await pool.getConnection();
  try {
    let syncToken = force ? null : await getSyncToken(conn);
    let result;
    try {
      result = syncToken
        ? await gcal.listEventsForSync({ syncToken })
        : await gcal.listEventsForSync({ timeMin: backfillTimeMin() });
    } catch (e) {
      const code = e.code || (e.response && e.response.status);
      if (code === 410) {
        // syncToken expirado → resync completo
        syncToken = null;
        result = await gcal.listEventsForSync({ timeMin: backfillTimeMin() });
      } else {
        throw e;
      }
    }

    for (const ev of result.items) await upsertEvent(conn, ev);
    await saveSyncToken(conn, result.nextSyncToken || syncToken, `ok:${result.items.length}`);
    return { count: result.items.length, mode: syncToken ? 'incremental' : 'full' };
  } catch (e) {
    try { await saveSyncToken(conn, await getSyncToken(conn), `error:${e.message}`); } catch (_) {}
    throw e;
  } finally {
    conn.release();
    running = false;
  }
}

// Arranca el sincronizador periódico (setInterval, sin cron externo).
// Primer sync poco después de arrancar; luego cada GCAL_SYNC_INTERVAL_MIN min.
function startSyncLoop() {
  if (!gcal.isConfigured()) {
    console.log('[gcal-sync] Google Calendar no configurado; espejo desactivado.');
    return;
  }
  const minutes = Math.max(1, Number(process.env.GCAL_SYNC_INTERVAL_MIN || 5));
  const tick = () =>
    syncAppointments()
      .then((r) => r && r.skipped ? null : console.log('[gcal-sync]', JSON.stringify(r)))
      .catch((e) => console.warn('[gcal-sync] error:', e.message));
  setTimeout(tick, 5000);
  setInterval(tick, minutes * 60 * 1000);
  console.log(`[gcal-sync] activo · cada ${minutes} min · backfill ${BACKFILL_MONTHS} meses`);
}

module.exports = { syncAppointments, startSyncLoop };
