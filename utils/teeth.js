// utils/teeth.js
const db = require('../config/db')

// Acepta ["_27","27",27] etc -> [27, ...] únicos y ordenados
function normalizeToothCodes(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()

  for (const raw of input) {
    if (raw == null) continue
    const s = String(raw).trim()
    if (!s) continue
    const n = Number(s.replace(/^_/, ''))
    if (!Number.isFinite(n)) continue
    const code = Math.trunc(n)
    if (code <= 0) continue
    if (!seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }

  out.sort((a, b) => a - b)
  return out
}

// Reemplaza dientes de un treatment (patient_service_id)
async function replaceServiceTeeth(conn, patientServiceId, toothCodes) {
  await conn.query(
    `DELETE FROM patient_service_teeth WHERE patient_service_id = ?`,
    [patientServiceId]
  )

  if (!toothCodes?.length) return

  // valida que existan en teeth
  const [rows] = await conn.query(
    `SELECT tooth_code FROM teeth WHERE tooth_code IN (?)`,
    [toothCodes]
  )
  const valid = new Set(rows.map(r => Number(r.tooth_code)))
  const finalCodes = toothCodes.filter(c => valid.has(c))

  if (!finalCodes.length) return

  const values = finalCodes.map(code => [patientServiceId, code])
  await conn.query(
    `INSERT INTO patient_service_teeth (patient_service_id, tooth_code) VALUES ?`,
    [values]
  )
}

module.exports = { normalizeToothCodes, replaceServiceTeeth }
