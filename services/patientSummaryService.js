// services/patientSummaryService.js
const pool = require("../config/db");
// Las citas viven en Google Calendar; aquí se leen del espejo local `appointments`
// (se mantiene al día en services/appointmentsSync.js).

async function getPatientSummary(patientId) {
  const pid = Number(patientId);
  if (!pid || Number.isNaN(pid)) throw new Error("patientId inválido");

  const conn = await pool.getConnection();
  try {
    // 1) Info básica del paciente
    const [patientRows] = await conn.query(
      `
      SELECT id, nombre, apellidos, telefono, email, fecha_nacimiento
      FROM pacientes
      WHERE id = ?
      `,
      [pid]
    );
    const patient = patientRows[0] || null;

    const [serviceRows] = await conn.query(
      `
      SELECT 
        ps.id,
        ps.service_date,
        ps.notes,
        ps.status,
        ps.total_cost,
        s.name  AS service_name,
        sc.name AS service_category,
        sc.id   AS service_category_id
      FROM patient_services AS ps
      JOIN services AS s ON s.id = ps.service_id
      JOIN service_categories AS sc ON sc.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC
      LIMIT 1
      `,
      [pid]
    );
    const lastService = serviceRows[0] || null;

    // 3) Citas desde el ESPEJO local `appointments` (se sincroniza con Google
    //    Calendar en appointmentsSync). Consulta rápida por índice; devolvemos
    //    la ÚLTIMA pasada y la PRÓXIMA futura. Comparamos contra UTC_TIMESTAMP()
    //    porque start_at se guarda en UTC.
    let lastAppointment = null;
    let nextAppointment = null;
    try {
      const cols = `event_id, start_iso, end_iso, treatment, observations, status, source`;
      const [pastRows] = await conn.query(
        `SELECT ${cols} FROM appointments
         WHERE patient_id = ? AND start_at IS NOT NULL AND start_at <= UTC_TIMESTAMP()
         ORDER BY start_at DESC LIMIT 1`,
        [pid]
      );
      const [nextRows] = await conn.query(
        `SELECT ${cols} FROM appointments
         WHERE patient_id = ? AND start_at IS NOT NULL AND start_at > UTC_TIMESTAMP()
         ORDER BY start_at ASC LIMIT 1`,
        [pid]
      );
      const toSummary = (r) =>
        r && {
          eventId: r.event_id,
          appointment_at: r.start_iso, // alias esperado por la UI y clinic-ai
          start: r.start_iso,
          end: r.end_iso,
          service_name: r.treatment, // etiqueta mostrable (tratamiento o título)
          observaciones: r.observations,
          status: r.status,
          source: r.source,
        };
      lastAppointment = toSummary(pastRows[0]);
      nextAppointment = toSummary(nextRows[0]);
    } catch (e) {
      // Si el espejo aún no existe (migración/sync pendiente), no rompemos el resumen.
      console.warn("patientSummary: no se pudieron leer citas del espejo:", e.message);
    }

    // 4) Último pago
    const [paymentRows] = await conn.query(
      `
      SELECT 
        pp.id,
        pp.fecha,
        pp.tratamiento,
        pp.monto,
        pm.name AS payment_method,
        ps2.name AS payment_status
      FROM patient_payments AS pp
      LEFT JOIN payment_methods   AS pm  ON pm.id  = pp.payment_method_id
      LEFT JOIN payment_statuses  AS ps2 ON ps2.id = pp.payment_status_id
      WHERE pp.patient_id = ?
      ORDER BY pp.fecha DESC
      LIMIT 1
      `,
      [pid]
    );
    const lastPayment = paymentRows[0] || null;

    return { patient, lastService, lastAppointment, nextAppointment, lastPayment };
  } finally {
    conn.release();
  }
}

module.exports = { getPatientSummary };
