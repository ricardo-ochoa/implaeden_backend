// routes/patientTreatments.js
const express = require("express")
const db = require("../config/db")
const router = express.Router({ mergeParams: true })
const { logPatientEvent } = require("../utils/logPatientEvent")

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

const toMoney = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    Number(n || 0)
  )

const VALID_STATUSES = ["Por Iniciar", "En proceso", "Terminado"]

const normalizeStatus = (raw) => {
  const v = String(raw ?? "").trim().toLowerCase()
  if (!v) return "Por Iniciar"
  if (v === "terminado") return "Terminado"
  if (v === "en proceso") return "En proceso"
  if (v === "por iniciar") return "Por Iniciar"
  return null
}

const toNumber = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// --- helper: detecta si existe una columna (evita "Unknown column")
async function hasColumn(table, column) {
  const [rows] = await db.query(
    `SHOW COLUMNS FROM \`${table}\` LIKE ?`,
    [column]
  )
  return rows.length > 0
}

/**
 * GET /api/pacientes/:patientId/tratamientos
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    if (!patientId) return res.status(400).json({ error: "patientId inválido" })

    const query = `
      SELECT 
        ps.id AS treatment_id,
        ps.patient_id,
        ps.group_id AS group_id,
        ps.service_id,
        ps.service_date,
        ps.notes,
        ps.status,
        ps.total_cost AS total_cost,
        s.name AS service_name,
        c.id   AS service_category_id,
        c.name AS service_category,
        c.sort_order AS service_category_sort_order
      FROM patient_services ps
      JOIN services s ON ps.service_id = s.id
      JOIN service_categories c ON c.id = s.category_id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC, ps.id DESC
    `

    const [rows] = await db.query(query, [patientId])
    res.json(rows)
  })
)

/**
 * POST /api/pacientes/:patientId/tratamientos
 * ✅ Acepta:
 * - { service_id, service_date, ... } (uno)
 * - { services: [{...}, {...}] } (varios)
 * ✅ SIEMPRE crea group_id (aunque sea 1)
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    if (!patientId) return res.status(400).json({ error: "patientId inválido" })

    const createdBy = req.user?.id ?? null

    const incoming = Array.isArray(req.body?.services)
      ? req.body.services
      : [req.body]

    if (!incoming.length) {
      return res.status(400).json({ error: "services requerido" })
    }

    // validación base (primero)
    for (const item of incoming) {
      const sid = toNumber(item?.service_id)
      if (!sid) return res.status(400).json({ error: "service_id es obligatorio" })
      if (!item?.service_date) return res.status(400).json({ error: "service_date es obligatorio" })

      const normalized = normalizeStatus(item?.status)
      if (!normalized || !VALID_STATUSES.includes(normalized)) {
        return res.status(400).json({ error: "Estado no válido.", valid: VALID_STATUSES })
      }

      const [svc] = await db.query("SELECT id FROM services WHERE id = ? LIMIT 1", [sid])
      if (!svc.length) return res.status(400).json({ error: `service_id ${sid} no existe` })

      const cost = item.total_cost == null || item.total_cost === "" ? 0 : toNumber(item.total_cost)
      if (cost == null) return res.status(400).json({ error: "total_cost no es válido" })
    }

    // columna created_by opcional
    const patientServicesHasCreatedBy = await hasColumn("patient_services", "created_by")

    // 1) inserta el primero sin group_id (temporal)
    const first = incoming[0]
    const firstSid = toNumber(first.service_id)
    const firstCost =
      first.total_cost == null || first.total_cost === "" ? 0 : toNumber(first.total_cost)
    const firstStatus = normalizeStatus(first.status)

    let insFirst
    if (patientServicesHasCreatedBy) {
      ;[insFirst] = await db.query(
        `
        INSERT INTO patient_services
          (patient_id, service_id, service_date, notes, status, total_cost, group_id, created_by, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, NULL, ?, NOW(), NOW())
        `,
        [
          patientId,
          firstSid,
          first.service_date,
          first.notes || null,
          firstStatus,
          Number(firstCost || 0),
          createdBy,
        ]
      )
    } else {
      ;[insFirst] = await db.query(
        `
        INSERT INTO patient_services
          (patient_id, service_id, service_date, notes, status, total_cost, group_id, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, NULL, NOW(), NOW())
        `,
        [
          patientId,
          firstSid,
          first.service_date,
          first.notes || null,
          firstStatus,
          Number(firstCost || 0),
        ]
      )
    }

    const firstId = insFirst.insertId
    const groupId = firstId

    // 2) set group_id del primero
    await db.query(
      `UPDATE patient_services SET group_id = ?, updated_at = NOW() WHERE id = ? AND patient_id = ?`,
      [groupId, firstId, patientId]
    )

    // 3) inserta el resto con group_id
    for (const item of incoming.slice(1)) {
      const sid = toNumber(item.service_id)
      const cost = item.total_cost == null || item.total_cost === "" ? 0 : toNumber(item.total_cost)
      const st = normalizeStatus(item.status)

      if (patientServicesHasCreatedBy) {
        await db.query(
          `
          INSERT INTO patient_services
            (patient_id, service_id, service_date, notes, status, total_cost, group_id, created_by, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [
            patientId,
            sid,
            item.service_date,
            item.notes || null,
            st,
            Number(cost || 0),
            groupId,
            createdBy,
          ]
        )
      } else {
        await db.query(
          `
          INSERT INTO patient_services
            (patient_id, service_id, service_date, notes, status, total_cost, group_id, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `,
          [
            patientId,
            sid,
            item.service_date,
            item.notes || null,
            st,
            Number(cost || 0),
            groupId,
          ]
        )
      }
    }

    // 4) responder con los creados del group
    const [rows] = await db.query(
      `
      SELECT
        ps.id AS treatment_id,
        ps.patient_id,
        ps.service_id,
        ps.service_date,
        ps.total_cost,
        ps.status,
        ps.group_id,
        s.name AS service_name
      FROM patient_services ps
      LEFT JOIN services s ON s.id = ps.service_id
      WHERE ps.patient_id = ? AND ps.group_id = ?
      ORDER BY ps.id ASC
      `,
      [patientId, groupId]
    )

    res.status(201).json({
      message: "Tratamiento(s) creado(s) exitosamente.",
      group_id: groupId,
      items: rows,
    })
  })
)

/**
 * PATCH /api/pacientes/:patientId/tratamientos/:treatmentId
 * Actualiza campos variados
 */
router.patch(
  "/:treatmentId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const { total_cost, notes, service_date, service_id, status } = req.body

    // cargar previo (para log de costo)
    let oldCost = null
    let newCost = null

    if (total_cost !== undefined) {
      const [[prev]] = await db.query(
        `SELECT total_cost, group_id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
        [treatmentId, patientId]
      )
      if (!prev) return res.status(404).json({ error: "Tratamiento no encontrado." })

      oldCost = Number(prev.total_cost || 0)
      newCost = total_cost == null || total_cost === "" ? 0 : toNumber(total_cost)
      if (newCost == null) return res.status(400).json({ error: "total_cost no es válido" })
    }

    const sets = []
    const values = []

    if (total_cost !== undefined) {
      sets.push("total_cost = ?")
      values.push(newCost)
    }

    if (notes !== undefined) {
      sets.push("notes = ?")
      values.push(notes || null)
    }

    if (service_date !== undefined) {
      if (!service_date) return res.status(400).json({ error: "service_date no es válido" })
      sets.push("service_date = ?")
      values.push(service_date)
    }

    if (service_id !== undefined) {
      const sid = toNumber(service_id)
      if (!sid) return res.status(400).json({ error: "service_id no es válido" })

      const [svc] = await db.query("SELECT id FROM services WHERE id = ? LIMIT 1", [sid])
      if (!svc.length) return res.status(400).json({ error: "service_id no existe" })

      sets.push("service_id = ?")
      values.push(sid)
    }

    if (status !== undefined) {
      const normalized = normalizeStatus(status)
      if (!normalized || !VALID_STATUSES.includes(normalized)) {
        return res.status(400).json({ error: "Estado no válido.", valid: VALID_STATUSES })
      }
      sets.push("status = ?")
      values.push(normalized)
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No hay campos para actualizar." })
    }

    sets.push("updated_at = NOW()")

    const query = `
      UPDATE patient_services
      SET ${sets.join(", ")}
      WHERE id = ? AND patient_id = ?
    `
    values.push(treatmentId, patientId)

    const [result] = await db.query(query, values)

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tratamiento no encontrado." })
    }

    // log de cambio de costo
    if (total_cost !== undefined && oldCost !== null && newCost !== null && oldCost !== newCost) {
      // resolver group_id para el evento (siempre debería existir)
      const [[ps]] = await db.query(
        `SELECT group_id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
        [treatmentId, patientId]
      )
      const gid = ps?.group_id ? Number(ps.group_id) : null

      await logPatientEvent({
        patientId,
        patientServiceId: treatmentId,
        patientServiceGroupId: gid,
        eventType: "cost_changed",
        message: `Costo actualizado: ${toMoney(oldCost)} → ${toMoney(newCost)}`,
        meta: { old_cost: oldCost, new_cost: newCost },
        createdBy: req.user?.id ?? null,
      })
    }

    res.status(200).json({
      message: "Tratamiento actualizado exitosamente.",
    })
  })
)

/**
 * PUT /api/pacientes/:patientId/tratamientos/:treatmentId/status
 */
router.put(
  "/:treatmentId/status",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const { status } = req.body
    const normalized = normalizeStatus(status)

    if (!normalized || !VALID_STATUSES.includes(normalized)) {
      return res.status(400).json({ error: "Estado no válido.", valid: VALID_STATUSES })
    }

    const [result] = await db.query(
      `UPDATE patient_services
       SET status = ?, updated_at = NOW()
       WHERE id = ? AND patient_id = ?`,
      [normalized, treatmentId, patientId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tratamiento no encontrado para este paciente." })
    }

    res.json({ message: "Estado actualizado exitosamente." })
  })
)

/**
 * PUT /api/pacientes/:patientId/tratamientos/:treatmentId/costo
 * Body: { total_cost }
 */
router.put(
  "/:treatmentId/costo",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const newCost = req.body?.total_cost == null || req.body?.total_cost === ""
      ? 0
      : toNumber(req.body?.total_cost)

    if (newCost == null) {
      return res.status(400).json({ error: "total_cost inválido" })
    }

    // leer previo + group
    const [[prev]] = await db.query(
      `SELECT total_cost, group_id
       FROM patient_services
       WHERE id = ? AND patient_id = ?
       LIMIT 1`,
      [treatmentId, patientId]
    )

    if (!prev) return res.status(404).json({ error: "Tratamiento no encontrado." })

    const oldCost = Number(prev.total_cost || 0)
    const gid = prev?.group_id ? Number(prev.group_id) : null

    await db.query(
      `UPDATE patient_services
       SET total_cost = ?, updated_at = NOW()
       WHERE id = ? AND patient_id = ?`,
      [newCost, treatmentId, patientId]
    )

    if (oldCost !== newCost) {
      await logPatientEvent({
        patientId,
        patientServiceId: treatmentId,
        patientServiceGroupId: gid,
        eventType: "cost_changed",
        message: `Costo actualizado: ${toMoney(oldCost)} → ${toMoney(newCost)}`,
        meta: { old_cost: oldCost, new_cost: newCost },
        createdBy: req.user?.id ?? null,
      })
    }

    res.json({ ok: true, total_cost: newCost })
  })
)

/**
 * DELETE /api/pacientes/:patientId/tratamientos/:treatmentId
 * ✅ recomendado: borra eventos relacionados para no dejar huérfanos
 */
router.delete(
  "/:treatmentId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    // borra eventos del treatment
    await db.query(
      `DELETE FROM patient_treatment_events WHERE patient_id = ? AND patient_service_id = ?`,
      [patientId, treatmentId]
    )

    const [result] = await db.query(
      "DELETE FROM patient_services WHERE id = ? AND patient_id = ?",
      [treatmentId, patientId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tratamiento no encontrado en la base de datos." })
    }

    res.status(200).json({ message: "Tratamiento eliminado exitosamente." })
  })
)

module.exports = router
