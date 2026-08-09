// services/patientSummaryService.js
const pool = require("../config/db");
const gcal = require("./googleCalendar"); // citas viven en Google Calendar (la tabla `citas` es legacy)

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

    // 3) Citas desde Google Calendar (la tabla `citas` quedó legacy).
    //    Devolvemos la ÚLTIMA pasada y la PRÓXIMA futura. Si GCal no está
    //    configurado o falla, NO rompemos el resumen (quedan en null).
    let lastAppointment = null;
    let nextAppointment = null;
    try {
      const appts = await gcal.listByPatient(pid); // vinculadas al paciente, orden asc por inicio
      const now = Date.now();
      // Normalizamos al shape que ya consume la UI/IA (appointment_at + service_name).
      const toSummary = (a) =>
        a && {
          eventId: a.eventId,
          appointment_at: a.start, // alias esperado por la UI y clinic-ai
          start: a.start,
          end: a.end,
          service_name: a.treatment, // etiqueta mostrable (tratamiento o título del evento)
          observaciones: a.observations,
          status: a.status,
          source: a.source,
        };
      const withStart = appts.filter((a) => a.start && !Number.isNaN(new Date(a.start).getTime()));
      const past = withStart.filter((a) => new Date(a.start).getTime() <= now);
      const upcoming = withStart.filter((a) => new Date(a.start).getTime() > now);
      lastAppointment = toSummary(past[past.length - 1]); // más reciente pasada
      nextAppointment = toSummary(upcoming[0]); // más próxima futura
    } catch (e) {
      // GCAL_NOT_CONFIGURED u otro error de Calendar: dejamos las citas en null.
      if (e && e.code !== "GCAL_NOT_CONFIGURED") {
        console.warn("patientSummary: no se pudieron leer citas de GCal:", e.message);
      }
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
