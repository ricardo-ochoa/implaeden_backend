// services/patientSummaryService.js
const pool = require("../config/db");

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

    // 3) Última cita registrada (en el pasado) (NORMALIZADO)
    const [appointmentRows] = await conn.query(
      `
      SELECT 
        c.id,
        c.appointment_at,
        c.observaciones,
        s.name  AS service_name,
        sc.name AS service_category,
        sc.id   AS service_category_id
      FROM citas AS c
      JOIN services AS s ON s.id = c.service_id
      JOIN service_categories AS sc ON sc.id = s.category_id
      WHERE c.patient_id = ?
        AND c.appointment_at <= NOW()
      ORDER BY c.appointment_at DESC
      LIMIT 1
      `,
      [pid]
    );
    const lastAppointment = appointmentRows[0] || null;

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

    return { patient, lastService, lastAppointment, lastPayment };
  } finally {
    conn.release();
  }
}

module.exports = { getPatientSummary };
