// routes/patientTreatmentEvents.js
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

// GET /api/pacientes/:patientId/events
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params

    const limit = Math.min(Number(req.query.limit) || 200, 500)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const patientServiceId = req.query.patient_service_id
      ? Number(req.query.patient_service_id)
      : null

    const patientServiceGroupId = req.query.patient_service_group_id
      ? Number(req.query.patient_service_group_id)
      : null

    const type = req.query.type ? String(req.query.type) : null

    const where = ['e.patient_id = ?']
    const params = [Number(patientId)]

    if (patientServiceId) {
      where.push('e.patient_service_id = ?')
      params.push(patientServiceId)
    }

    // Si filtras por grupo: incluye eventos generales del grupo y eventos colgados a tratamientos del grupo
    if (patientServiceGroupId) {
      where.push('(e.patient_service_group_id = ? OR ps.group_id = ?)')
      params.push(patientServiceGroupId, patientServiceGroupId)
    }

    if (type) {
      where.push('e.event_type = ?')
      params.push(type)
    }

    const whereSql = `WHERE ${where.join(' AND ')}`

    const sql = `
      SELECT
        e.id,
        e.patient_id,
        e.patient_service_id,
        e.patient_service_group_id,
        e.event_type,
        e.message,
        e.meta,
        e.created_by,
        e.created_at,
        s.name AS service_name
      FROM patient_treatment_events e
      LEFT JOIN patient_services ps ON ps.id = e.patient_service_id
      LEFT JOIN services s ON s.id = ps.service_id
      ${whereSql}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ? OFFSET ?
    `

    const countSql = `
      SELECT COUNT(*) AS total
      FROM patient_treatment_events e
      LEFT JOIN patient_services ps ON ps.id = e.patient_service_id
      ${whereSql}
    `

    const [[countRow]] = await db.query(countSql, params)
    const [rows] = await db.query(sql, [...params, limit, offset])

    res.json({
      items: (rows || []).map((r) => ({ ...r, meta: safeJsonParse(r.meta) })),
      total: countRow?.total || 0,
      limit,
      offset,
    })
  })
)

// POST /api/pacientes/:patientId/events
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const createdBy = req.user?.id ?? null

    const {
      event_type = 'note',
      message,
      patient_service_id = null,
      patient_service_group_id = null,
      meta = null,
    } = req.body

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message es requerido' })
    }

    if (!patient_service_id && !patient_service_group_id) {
      return res.status(400).json({
        error: 'Debes enviar patient_service_id o patient_service_group_id',
      })
    }

    // Autocompleta group_id si mandas treatment pero no group
    let resolvedGroupId = patient_service_group_id
      ? Number(patient_service_group_id)
      : null

    if (!resolvedGroupId && patient_service_id) {
      const [[ps]] = await db.query(
        `SELECT group_id FROM patient_services WHERE id = ? LIMIT 1`,
        [Number(patient_service_id)]
      )
      resolvedGroupId = ps?.group_id ? Number(ps.group_id) : null
    }

    const metaJson =
      meta == null ? null : typeof meta === 'string' ? meta : JSON.stringify(meta)

    const [ins] = await db.query(
      `
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
      `,
      [
        Number(patientId),
        patient_service_id ? Number(patient_service_id) : null,
        resolvedGroupId,
        String(event_type),
        String(message),
        metaJson,
        createdBy,
      ]
    )

    const [rows] = await db.query(
      `
      SELECT
        e.id,
        e.patient_id,
        e.patient_service_id,
        e.patient_service_group_id,
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

    const out = rows?.[0] || null
    if (out) out.meta = safeJsonParse(out.meta)

    res.status(201).json(out)
  })
)

module.exports = router
