// utils/logPatientEvent.js
const db = require('../config/db')

async function logPatientEvent({
  patientId,
  patientServiceId = null,
  patientServiceGroupId = null,
  eventType = 'note',
  message,
  meta = null,
  createdBy = null,
}) {
  if (!patientId) throw new Error('patientId requerido')
  if (!message || !String(message).trim()) throw new Error('message requerido')

  if (!patientServiceId && !patientServiceGroupId) {
    throw new Error('Debes enviar patientServiceId o patientServiceGroupId')
  }

  const metaJson =
    meta == null ? null : typeof meta === 'string' ? meta : JSON.stringify(meta)

  const sql = `
    INSERT INTO patient_treatment_events (
      patient_id,
      patient_service_id,
      patient_service_group_id,
      event_type,
      message,
      meta,
      created_by,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `

  const [ins] = await db.query(sql, [
    Number(patientId),
    patientServiceId ? Number(patientServiceId) : null,
    patientServiceGroupId ? Number(patientServiceGroupId) : null,
    String(eventType),
    String(message),
    metaJson,
    createdBy ? Number(createdBy) : null,
  ])

  return ins.insertId
}

module.exports = { logPatientEvent }
