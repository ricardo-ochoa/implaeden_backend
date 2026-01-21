// services/patientEventsService.js
const express = require('express')
const router = express.Router({ mergeParams: true })
const db = require('../config/db')

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

const safeJsonParse = (v) => {
  if (!v) return null
  if (typeof v === 'object') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/**
 * ✅ Helper reutilizable para registrar eventos desde CUALQUIER lugar
 * (tratamientos, pagos, documentos, etc.)
 *
 * OJO: tu tabla NO tiene updated_at, así que solo insertamos created_at.
 */
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
  if (!eventType) throw new Error('eventType requerido')
  if (!message || !String(message).trim()) throw new Error('message requerido')

  const metaJson =
    meta === null || meta === undefined ? null : JSON.stringify(meta)

  const insertSql = `
    INSERT INTO patient_treatment_events
      (patient_id, patient_service_id, event_type, message, meta, created_by, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, NOW())
  `

  const [ins] = await db.query(insertSql, [
    Number(patientId),
    patientServiceId ? Number(patientServiceId) : null,
    String(eventType),
    String(message),
    metaJson,
    createdBy ? Number(createdBy) : null,
  ])

  return ins.insertId
}

// ✅ CLAVE: adjuntamos la función al router SIN romper exports existentes
router.logPatientEvent = logPatientEvent

// ----------------------------------------------------
// GET /api/pacientes/:patientId/events
// filtros opcionales:
//  - patient_service_id
//  - type (event_type)
//  - limit, offset
//  - from, to (created_at)
// ----------------------------------------------------
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const {
      patient_service_id,
      type,
      limit = 50,
      offset = 0,
      from,
      to,
    } = req.query

    const where = ['e.patient_id = ?']
    const params = [Number(patientId)]

    if (patient_service_id) {
      where.push('e.patient_service_id = ?')
      params.push(Number(patient_service_id))
    }

    if (type) {
      where.push('e.event_type = ?')
      params.push(String(type))
    }

    if (from) {
      where.push('e.created_at >= ?')
      params.push(String(from))
    }

    if (to) {
      where.push('e.created_at <= ?')
      params.push(String(to))
    }

    const sql = `
      SELECT
        e.id,
        e.patient_id,
        e.patient_service_id,
        e.event_type,
        e.message,
        e.meta,
        e.created_by,
        e.created_at,
        s.name AS service_name
      FROM patient_treatment_events e
      LEFT JOIN patient_services ps ON ps.id = e.patient_service_id
      LEFT JOIN services s ON s.id = ps.service_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ? OFFSET ?
    `

    params.push(Number(limit))
    params.push(Number(offset))

    const [rows] = await db.query(sql, params)

    const normalized = rows.map((r) => ({
      ...r,
      meta: safeJsonParse(r.meta),
    }))

    res.json(normalized)
  })
)

// ----------------------------------------------------
// POST /api/pacientes/:patientId/events
// crea un evento "manual" (comentario / nota)
// body:
//  - patient_service_id (opcional)
//  - event_type (default: "note")
//  - message (requerido)
//  - meta (opcional)
// ----------------------------------------------------
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const {
      patient_service_id = null,
      event_type = 'note',
      message,
      meta = null,
    } = req.body

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message es requerido' })
    }

    const createdBy = req.user?.id ?? null

    const insertSql = `
      INSERT INTO patient_treatment_events
        (patient_id, patient_service_id, event_type, message, meta, created_by, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, NOW())
    `

    const metaJson =
      meta === null || meta === undefined ? null : JSON.stringify(meta)

    const [ins] = await db.query(insertSql, [
      Number(patientId),
      patient_service_id ? Number(patient_service_id) : null,
      String(event_type),
      String(message),
      metaJson,
      createdBy ? Number(createdBy) : null,
    ])

    const [rows] = await db.query(
      `
      SELECT
        e.id,
        e.patient_id,
        e.patient_service_id,
        e.event_type,
        e.message,
        e.meta,
        e.created_by,
        e.created_at,
        s.name AS service_name
      FROM patient_treatment_events e
      LEFT JOIN patient_services ps ON ps.id = e.patient_service_id
      LEFT JOIN services s ON s.id = ps.service_id
      WHERE e.id = ?
      LIMIT 1
      `,
      [ins.insertId]
    )

    const out = rows[0] || null
    if (out) out.meta = safeJsonParse(out.meta)

    res.status(201).json(out)
  })
)

// ----------------------------------------------------
// PUT /api/pacientes/:patientId/events/:id
// edita SOLO eventos tipo "note"
// ----------------------------------------------------
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params
    const { message, meta = null } = req.body

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message es requerido' })
    }

    const [check] = await db.query(
      `SELECT id, event_type FROM patient_treatment_events WHERE id = ? AND patient_id = ? LIMIT 1`,
      [Number(id), Number(patientId)]
    )

    if (!check.length) {
      return res.status(404).json({ error: 'Evento no encontrado.' })
    }

    if (check[0].event_type !== 'note') {
      return res.status(403).json({ error: 'Solo se pueden editar eventos tipo note.' })
    }

    const metaJson =
      meta === null || meta === undefined ? null : JSON.stringify(meta)

    const updateSql = `
      UPDATE patient_treatment_events
      SET message = ?, meta = ?
      WHERE id = ? AND patient_id = ?
    `

    const [result] = await db.query(updateSql, [
      String(message),
      metaJson,
      Number(id),
      Number(patientId),
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evento no encontrado.' })
    }

    res.json({ message: 'Evento actualizado exitosamente.' })
  })
)

// ----------------------------------------------------
// DELETE /api/pacientes/:patientId/events/:id
// elimina SOLO eventos tipo "note"
// ----------------------------------------------------
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { patientId, id } = req.params

    const [check] = await db.query(
      `SELECT id, event_type FROM patient_treatment_events WHERE id = ? AND patient_id = ? LIMIT 1`,
      [Number(id), Number(patientId)]
    )

    if (!check.length) {
      return res.status(404).json({ error: 'Evento no encontrado.' })
    }

    if (check[0].event_type !== 'note') {
      return res.status(403).json({ error: 'Solo se pueden eliminar eventos tipo note.' })
    }

    const [result] = await db.query(
      `DELETE FROM patient_treatment_events WHERE id = ? AND patient_id = ?`,
      [Number(id), Number(patientId)]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evento no encontrado.' })
    }

    res.json({ message: 'Evento eliminado exitosamente.' })
  })
)

module.exports = router
