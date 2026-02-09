// routes/tratamientos.js
const express = require("express")
const db = require("../config/db")
const router = express.Router({ mergeParams: true })

const { logPatientEvent } = require("../utils/logPatientEvent")
const { normalizeToothCodes, replaceServiceTeeth } = require("../utils/teeth")

const multer = require("multer")
const AWS = require("aws-sdk")

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
})

const s3 = new AWS.S3()

const upload = multer({ storage: multer.memoryStorage() })

const commentUpload = upload.fields([
  { name: 'file', maxCount: 10 },
  { name: 'files', maxCount: 10 },
  { name: 'media', maxCount: 10 },
  { name: 'evidence', maxCount: 10 },
  { name: 'evidences', maxCount: 10 },
  { name: 'file[]', maxCount: 10 },
])

const collectFiles = (req) => {
  // con upload.fields -> req.files es objeto { file:[], files:[]... }
  const obj = req.files || {}
  return Object.values(obj).flat()
}

const S3_BUCKET = process.env.AWS_S3_BUCKET || "implaeden"

const normalizeText = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")

const normalizeDocType = (raw) => {
  const v = normalizeText(raw)

  // ✅ aceptamos valores “bonitos” que tu UI podría mandar
  if (v === "budget" || v === "presupuesto") return "budget"

  if (
    v === "start_letter" ||
    v === "carta_inicio" ||
    v === "inicio" ||
    v === "carta_de_inicio"
  )
    return "start_letter"

  if (
    v === "end_letter" ||
    v === "carta_fin" ||
    v === "fin" ||
    v === "carta_de_fin"
  )
    return "end_letter"

  return null
}

const safeFileName = (name) =>
  String(name || "file")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120)

const buildS3Key = ({ patientId, treatmentId, docType, originalname }) => {
  const ts = Date.now()
  const clean = safeFileName(originalname)
  // puedes cambiar el folder si quieres
  return `clinical_histories/patient_${patientId}/treatment_${treatmentId}/${docType}/${ts}_${clean}`
}

const uploadFileToS3 = async ({ key, file }) => {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }
  const out = await s3.upload(params).promise()
  return out.Location
}

const extractS3KeyFromUrl = (fileUrl) => {
  try {
    const u = new URL(fileUrl)
    // pathname viene como "/clinical_histories/...."
    return decodeURIComponent(u.pathname.replace(/^\/+/, ""))
  } catch {
    // fallback: intenta por split
    const idx = String(fileUrl || "").indexOf("amazonaws.com/")
    if (idx === -1) return null
    return String(fileUrl).slice(idx + "amazonaws.com/".length)
  }
}


const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

const toMoney = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    Number(n || 0)
  )

const VALID_STATUSES = ["Por Iniciar", "En proceso", "Terminado"]
const VALID_DOC_TYPES = ["budget", "start_letter", "end_letter"]

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

const toInt = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const i = Math.trunc(n)
  if (i !== n) return null
  return i
}

const normalizeQuantity = (raw) => {
  if (raw === undefined || raw === null || raw === "") return 0
  const q = toInt(raw)
  if (q == null || q < 0) return null
  return q
}

// ✅ Helpers más confiables (information_schema)
async function hasColumn(table, column) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = ?
      AND column_name = ?
    LIMIT 1
    `,
    [table, column]
  )
  return rows.length > 0
}

async function hasTable(table) {
  const [rows] = await db.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = ?
    LIMIT 1
    `,
    [table]
  )
  return rows.length > 0
}

/**
 * Helper: arma el query del GET (con o sin teeth)
 */
async function buildTreatmentsQuery() {
  const hasQty = await hasColumn("patient_services", "quantity")
  const hasTeeth = await hasTable("patient_service_teeth")

  const qtySelect = hasQty ? "ps.quantity AS quantity," : "0 AS quantity,"

  const teethSelect = hasTeeth
    ? `
      COALESCE(ti.teeth_ids, JSON_ARRAY()) AS teeth_ids,
      COALESCE(gt.group_teeth_ids, JSON_ARRAY()) AS group_teeth_ids
    `
    : `
      JSON_ARRAY() AS teeth_ids,
      JSON_ARRAY() AS group_teeth_ids
    `

  const teethJoins = hasTeeth
    ? `
      LEFT JOIN (
        SELECT
          pst.patient_service_id,
          JSON_ARRAYAGG(pst.tooth_code) AS teeth_ids
        FROM patient_service_teeth pst
        GROUP BY pst.patient_service_id
      ) ti ON ti.patient_service_id = ps.id

      LEFT JOIN (
        SELECT
          dt.group_id,
          JSON_ARRAYAGG(dt.tooth_code) AS group_teeth_ids
        FROM (
          SELECT DISTINCT ps2.group_id, pst2.tooth_code
          FROM patient_services ps2
          JOIN patient_service_teeth pst2
            ON pst2.patient_service_id = ps2.id
          WHERE ps2.group_id IS NOT NULL
        ) dt
        GROUP BY dt.group_id
      ) gt ON gt.group_id = ps.group_id
    `
    : ""

  const baseSelect = `
    SELECT 
      ps.id AS treatment_id,
      ps.patient_id,
      ps.group_id,
      g.title      AS group_title,
      g.start_date AS group_start_date,
      g.status     AS group_status,

      ps.service_id,
      ps.service_date,
      ps.notes,
      ps.status,
      ps.total_cost AS total_cost,
      ${qtySelect}

      s.name AS service_name,
      c.id   AS service_category_id,
      c.name AS service_category,
      c.sort_order AS service_category_sort_order,

      ${teethSelect}

    FROM patient_services ps
    LEFT JOIN patient_service_groups g ON g.id = ps.group_id
    JOIN services s ON s.id = ps.service_id
    JOIN service_categories c ON c.id = s.category_id

    ${teethJoins}
  `

  return { baseSelect, hasQty, hasTeeth }
}

const parseJsonArray = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

const isQuillHtmlMeaningful = (html) => {
  const s = String(html ?? '').trim()
  if (!s) return false
  // quill vacío típico: "<p><br></p>"
  const textOnly = s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
  return textOnly.length > 0
}

const buildCommentS3Key = ({ patientId, treatmentId, commentId, originalname }) => {
  const ts = Date.now()
  const clean = safeFileName(originalname)
  return `clinical_histories/patient_${patientId}/treatment_${treatmentId}/comments/comment_${commentId}/${ts}_${clean}`
}


/**
 * GET /api/pacientes/:patientId/tratamientos
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    if (!patientId) return res.status(400).json({ error: "patientId inválido" })

    const meta = await buildTreatmentsQuery()
    console.log("GET tratamientos meta:", meta.hasTeeth, meta.hasQty)

    const { baseSelect } = await buildTreatmentsQuery()

    const query = `
      ${baseSelect}
      WHERE ps.patient_id = ?
      ORDER BY COALESCE(g.start_date, ps.service_date) DESC, ps.service_date DESC, ps.id DESC
    `

    const [rows] = await db.query(query, [patientId])
    res.json(rows)
  })
)

/**
 * POST /api/pacientes/:patientId/tratamientos
 * Acepta:
 * - { service_id, service_date, ... , teeth_ids } (uno)
 * - { services: [{...}, {...}] } (varios)
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    if (!patientId) return res.status(400).json({ error: "patientId inválido" })

    const createdBy = req.user?.id ?? null

    const incoming = Array.isArray(req.body?.services) ? req.body.services : [req.body]
    if (!incoming.length) return res.status(400).json({ error: "services requerido" })

    const patientServicesHasCreatedBy = await hasColumn("patient_services", "created_by")
    const patientServicesHasQty = await hasColumn("patient_services", "quantity")
    const teethTableExists = await hasTable("patient_service_teeth")

    // teeth_ids a nivel root (solo útil cuando mandas 1)
    const rootTeeth = req.body?.teeth_ids

    // valida items
    for (const item of incoming) {
      const sid = toNumber(item?.service_id)
      if (!sid) return res.status(400).json({ error: "service_id es obligatorio" })
      if (!item?.service_date) return res.status(400).json({ error: "service_date es obligatorio" })

      const normalized = normalizeStatus(item?.status)
      if (!normalized || !VALID_STATUSES.includes(normalized)) {
        return res.status(400).json({ error: "Estado no válido.", valid: VALID_STATUSES })
      }

      if (patientServicesHasQty) {
        const qty = normalizeQuantity(item?.quantity)
        if (qty == null) return res.status(400).json({ error: "quantity inválida (entero >= 0)" })
      }

      const [svc] = await db.query("SELECT id FROM services WHERE id = ? LIMIT 1", [sid])
      if (!svc.length) return res.status(400).json({ error: `service_id ${sid} no existe` })

      const cost = item.total_cost == null || item.total_cost === "" ? 0 : toNumber(item.total_cost)
      if (cost == null) return res.status(400).json({ error: "total_cost no es válido" })
      if (cost < 0) return res.status(400).json({ error: "total_cost no puede ser negativo" })
    }

    // group meta
    const groupTitleRaw = String(req.body?.title ?? "").trim()
    const groupTitle =
      groupTitleRaw || (incoming.length > 1 ? "Paquete de tratamientos" : "Tratamiento")

    const groupStartDate = incoming.reduce((min, it) => {
      const d = String(it?.service_date || "")
      if (!min) return d
      return new Date(d).getTime() < new Date(min).getTime() ? d : min
    }, "")

    const statuses = incoming.map((it) => normalizeStatus(it?.status))
    const allDone = statuses.every((s) => s === "Terminado")
    const anyInProgress = statuses.some((s) => s === "En proceso")
    const groupStatus = allDone ? "Terminado" : anyInProgress ? "En proceso" : "Por Iniciar"

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // 1) crear group
      const [g] = await conn.query(
        `
        INSERT INTO patient_service_groups
          (patient_id, title, start_date, status, notes, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [patientId, groupTitle, groupStartDate, groupStatus, null]
      )
      const groupId = g.insertId

      const createdTreatmentIds = []

      // 2) insertar items + teeth por item
      for (const item of incoming) {
        const sid = toNumber(item.service_id)
        const cost = item.total_cost == null || item.total_cost === "" ? 0 : toNumber(item.total_cost)
        const st = normalizeStatus(item.status)
        const qty = patientServicesHasQty ? normalizeQuantity(item.quantity) ?? 0 : 0

        let insertSql = ""
        let insertVals = []

        if (patientServicesHasCreatedBy && patientServicesHasQty) {
          insertSql = `
            INSERT INTO patient_services
              (patient_id, group_id, service_id, service_date, notes, status, total_cost, quantity, created_by, created_at, updated_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `
          insertVals = [patientId, groupId, sid, item.service_date, item.notes || null, st, Number(cost || 0), qty, createdBy]
        } else if (patientServicesHasCreatedBy && !patientServicesHasQty) {
          insertSql = `
            INSERT INTO patient_services
              (patient_id, group_id, service_id, service_date, notes, status, total_cost, created_by, created_at, updated_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `
          insertVals = [patientId, groupId, sid, item.service_date, item.notes || null, st, Number(cost || 0), createdBy]
        } else if (!patientServicesHasCreatedBy && patientServicesHasQty) {
          insertSql = `
            INSERT INTO patient_services
              (patient_id, group_id, service_id, service_date, notes, status, total_cost, quantity, created_at, updated_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `
          insertVals = [patientId, groupId, sid, item.service_date, item.notes || null, st, Number(cost || 0), qty]
        } else {
          insertSql = `
            INSERT INTO patient_services
              (patient_id, group_id, service_id, service_date, notes, status, total_cost, created_at, updated_at)
            VALUES
              (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `
          insertVals = [patientId, groupId, sid, item.service_date, item.notes || null, st, Number(cost || 0)]
        }

        const [ins] = await conn.query(insertSql, insertVals)
        const treatmentId = ins.insertId
        createdTreatmentIds.push(treatmentId)

        const rawTeeth =
          item?.teeth_ids !== undefined
            ? item.teeth_ids
            : (incoming.length === 1 ? rootTeeth : undefined)

        const codes = normalizeToothCodes(rawTeeth)
        await replaceServiceTeeth(conn, treatmentId, codes)
      }

      await conn.commit()

      // 3) responde con los items del group (ya con teeth)
      const { baseSelect } = await buildTreatmentsQuery()
      const [rows] = await db.query(
        `
        ${baseSelect}
        WHERE ps.patient_id = ? AND ps.group_id = ?
        ORDER BY ps.id ASC
        `,
        [patientId, groupId]
      )

      res.status(201).json({
        message: "Tratamiento(s) creado(s) exitosamente.",
        group_id: groupId,
        created_treatment_ids: createdTreatmentIds,
        items: rows,
      })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)

/**
 * PATCH /api/pacientes/:patientId/tratamientos/:treatmentId
 * - Actualiza campos de patient_services
 * - Actualiza teeth_ids (tabla patient_service_teeth) si existe
 * - ✅ group_start_date y service_date quedan SIEMPRE sincronizadas en todo el grupo
 * - Actualiza group_title (title) si viene
 * - Loggea evento de cambio de costo
 */
router.patch(
  "/:treatmentId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const {
      total_cost,
      notes,
      service_date,
      service_id,
      status,
      quantity,
      teeth_ids,

      // ✅ grupo
      group_start_date,
      group_title,
      title, // alias del front
    } = req.body

    const hasQty = await hasColumn("patient_services", "quantity")
    const teethTableExists = await hasTable("patient_service_teeth")
    const groupsTableExists = await hasTable("patient_service_groups")

    // ✅ si llega cualquiera, sincronizamos
    const dateToSync =
      group_start_date !== undefined ? group_start_date : service_date !== undefined ? service_date : undefined

    const validateDate = (d) => {
      if (!d) return false
      const dt = new Date(d)
      return !Number.isNaN(dt.getTime())
    }

    const conn = await db.getConnection()

    let oldCost = null
    let newCost = null
    let groupIdForEvent = null

    try {
      await conn.beginTransaction()

      // 🔒 lock del treatment
      const [[prev]] = await conn.query(
        `
        SELECT total_cost, group_id
        FROM patient_services
        WHERE id = ? AND patient_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [treatmentId, patientId]
      )

      if (!prev) {
        await conn.rollback()
        return res.status(404).json({ error: "Tratamiento no encontrado." })
      }

      groupIdForEvent = prev?.group_id ? Number(prev.group_id) : null

      // ✅ valida costo si viene
      if (total_cost !== undefined) {
        oldCost = Number(prev.total_cost || 0)
        newCost = total_cost == null || total_cost === "" ? 0 : toNumber(total_cost)
        if (newCost == null || newCost < 0) {
          await conn.rollback()
          return res.status(400).json({ error: "total_cost no es válido" })
        }
      }

      // ==========================
      // 1) UPDATE patient_services (campos normales)
      // ==========================
      const sets = []
      const values = []

      if (total_cost !== undefined) {
        sets.push("total_cost = ?")
        values.push(newCost)
      }

      if (hasQty && quantity !== undefined) {
        const q = normalizeQuantity(quantity)
        if (q == null) {
          await conn.rollback()
          return res.status(400).json({ error: "quantity inválida (entero >= 0)" })
        }
        sets.push("quantity = ?")
        values.push(q)
      }

      if (notes !== undefined) {
        sets.push("notes = ?")
        values.push(notes || null)
      }

      // ✅ SOLO actualiza service_date directo si NO pertenece a grupo o si NO estamos sincronizando
      // (si pertenece a grupo y viene dateToSync, se sincroniza en bloque más abajo)
      if (dateToSync !== undefined && !groupIdForEvent) {
        if (!validateDate(dateToSync)) {
          await conn.rollback()
          return res.status(400).json({ error: "service_date/group_start_date inválido" })
        }
        sets.push("service_date = ?")
        values.push(dateToSync)
      }

      if (service_id !== undefined) {
        const sid = toNumber(service_id)
        if (!sid) {
          await conn.rollback()
          return res.status(400).json({ error: "service_id no es válido" })
        }

        const [svc] = await conn.query(
          "SELECT id FROM services WHERE id = ? LIMIT 1",
          [sid]
        )
        if (!svc.length) {
          await conn.rollback()
          return res.status(400).json({ error: "service_id no existe" })
        }

        sets.push("service_id = ?")
        values.push(sid)
      }

      // dentro del PATCH /:treatmentId
      if (status !== undefined) {
        // ✅ si viene vacío, NO actualices status
        if (String(status).trim() === '') {
          // no haces nada
        } else {
          const normalized = normalizeStatus(status)
          if (!normalized || !VALID_STATUSES.includes(normalized)) {
            await conn.rollback()
            return res.status(400).json({ error: "Estado no válido.", valid: VALID_STATUSES })
          }
          sets.push("status = ?")
          values.push(normalized)
        }
      }


      if (sets.length > 0) {
        sets.push("updated_at = NOW()")
        values.push(treatmentId, patientId)

        await conn.query(
          `
          UPDATE patient_services
          SET ${sets.join(", ")}
          WHERE id = ? AND patient_id = ?
          `,
          values
        )
      }

      // ==========================
      // 2) UPDATE teeth (si existe)
      // ==========================
      if (teeth_ids !== undefined && teethTableExists) {
        const codes = normalizeToothCodes(teeth_ids)
        await replaceServiceTeeth(conn, treatmentId, codes)
      }

      // ==========================
      // 3) SYNC fechas del grupo (si aplica)
      // ==========================
      if (groupIdForEvent && dateToSync !== undefined) {
        if (!validateDate(dateToSync)) {
          await conn.rollback()
          return res.status(400).json({ error: "service_date/group_start_date inválido" })
        }

        // lock group
        if (groupsTableExists) {
          const [[g]] = await conn.query(
            `
            SELECT id
            FROM patient_service_groups
            WHERE id = ? AND patient_id = ?
            LIMIT 1
            FOR UPDATE
            `,
            [groupIdForEvent, patientId]
          )
          if (!g) {
            await conn.rollback()
            return res.status(404).json({ error: "Grupo no encontrado para este paciente." })
          }

          // ✅ update group.start_date
          await conn.query(
            `
            UPDATE patient_service_groups
            SET start_date = ?, updated_at = NOW()
            WHERE id = ? AND patient_id = ?
            `,
            [dateToSync, groupIdForEvent, patientId]
          )
        }

        // ✅ update TODOS los treatments del grupo con la misma service_date
        await conn.query(
          `
          UPDATE patient_services
          SET service_date = ?, updated_at = NOW()
          WHERE patient_id = ? AND group_id = ?
          `,
          [dateToSync, patientId, groupIdForEvent]
        )
      }

      // ==========================
      // 4) UPDATE title del grupo (si aplica)
      // ==========================
      const nextGroupTitle = group_title ?? title
      if (groupIdForEvent && nextGroupTitle !== undefined && groupsTableExists) {
        const t = String(nextGroupTitle || "").trim()
        if (!t) {
          await conn.rollback()
          return res.status(400).json({ error: "group_title inválido" })
        }

        await conn.query(
          `
          UPDATE patient_service_groups
          SET title = ?, updated_at = NOW()
          WHERE id = ? AND patient_id = ?
          `,
          [t, groupIdForEvent, patientId]
        )
      }

      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }

    // ==========================
    // 5) Log event (costo)
    // ==========================
    if (
      total_cost !== undefined &&
      oldCost !== null &&
      newCost !== null &&
      oldCost !== newCost
    ) {
      await logPatientEvent({
        patientId,
        patientServiceId: treatmentId,
        patientServiceGroupId: groupIdForEvent,
        eventType: "cost_changed",
        message: `Costo actualizado: ${toMoney(oldCost)} → ${toMoney(newCost)}`,
        meta: { old_cost: oldCost, new_cost: newCost },
        createdBy: req.user?.id ?? null,
      })
    }

    res.json({
      message: "Tratamiento actualizado exitosamente.",
      group_id: groupIdForEvent,
      synced_date: dateToSync !== undefined && groupIdForEvent ? dateToSync : null,
    })
  })
)


/**
 * PUT /api/pacientes/:patientId/tratamientos/:treatmentId/status
 * ✅ actualiza patient_services.status
 * ✅ si pertenece a grupo, recalcula y actualiza patient_service_groups.status
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

    const groupsTableExists = await hasTable("patient_service_groups")

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // 🔒 lock del treatment + obten group_id
      const [[row]] = await conn.query(
        `
        SELECT id, group_id
        FROM patient_services
        WHERE id = ? AND patient_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [treatmentId, patientId]
      )

      if (!row) {
        await conn.rollback()
        return res.status(404).json({ error: "Tratamiento no encontrado para este paciente." })
      }

      await conn.query(
        `
        UPDATE patient_services
        SET status = ?, updated_at = NOW()
        WHERE id = ? AND patient_id = ?
        `,
        [normalized, treatmentId, patientId]
      )

      const groupId = row?.group_id ? Number(row.group_id) : null
      let groupStatus = null

      // ✅ si pertenece a grupo, recalcula status del grupo
      if (groupId && groupsTableExists) {
        const [stRows] = await conn.query(
          `
          SELECT status
          FROM patient_services
          WHERE patient_id = ? AND group_id = ?
          `,
          [patientId, groupId]
        )

        const statuses = stRows.map((r) => normalizeStatus(r.status))
        const allDone = statuses.length > 0 && statuses.every((s) => s === "Terminado")
        const anyInProgress = statuses.some((s) => s === "En proceso")
        groupStatus = allDone ? "Terminado" : anyInProgress ? "En proceso" : "Por Iniciar"

        await conn.query(
          `
          UPDATE patient_service_groups
          SET status = ?, updated_at = NOW()
          WHERE id = ? AND patient_id = ?
          `,
          [groupStatus, groupId, patientId]
        )
      }

      await conn.commit()

      res.json({
        message: "Estado actualizado exitosamente.",
        status: normalized,
        group_id: groupId,
        group_status: groupStatus,
      })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)


/**
 * PUT /api/pacientes/:patientId/tratamientos/:treatmentId/costo
 */
router.put(
  "/:treatmentId/costo",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const newCost =
      req.body?.total_cost == null || req.body?.total_cost === ""
        ? 0
        : toNumber(req.body?.total_cost)

    if (newCost == null) return res.status(400).json({ error: "total_cost inválido" })

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

    // borra teeth (por si no tienes FK cascade)
    const teethTableExists = await hasTable("patient_service_teeth")
    if (teethTableExists) {
      await db.query(`DELETE FROM patient_service_teeth WHERE patient_service_id = ?`, [treatmentId])
    }

    // ✅ borra documentos (por si no tienes FK cascade)
    const docsTableExists = await hasTable("service_documents")
    if (docsTableExists) {
      await db.query(`DELETE FROM service_documents WHERE patient_service_id = ?`, [treatmentId])
    }

    const [result] = await db.query(
      "DELETE FROM patient_services WHERE id = ? AND patient_id = ?",
      [treatmentId, patientId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Tratamiento no encontrado en la base de datos." })
    }

    res.json({ message: "Tratamiento eliminado exitosamente." })
  })
)

// ======================================================================
// ✅ DOCUMENTOS (tabla: service_documents)
// Endpoints:
// GET    /api/pacientes/:patientId/tratamientos/:treatmentId/documentos
// POST   /api/pacientes/:patientId/tratamientos/:treatmentId/documentos
// DELETE /api/pacientes/:patientId/tratamientos/documentos/:docId   (opcional)
// ======================================================================

// ✅ GET documentos
router.get(
  "/:treatmentId/documentos",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    // valida pertenencia del tratamiento al paciente
    const [[own]] = await db.query(
      `SELECT id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
      [treatmentId, patientId]
    )
    if (!own) return res.status(404).json({ error: "Tratamiento no encontrado." })

    const docsTableExists = await hasTable("service_documents")
    if (!docsTableExists) return res.json([])

    const [rows] = await db.query(
      `
      SELECT id, patient_service_id, document_type, file_url, created_at, updated_at
      FROM service_documents
      WHERE patient_service_id = ?
      ORDER BY created_at DESC, id DESC
      `,
      [treatmentId]
    )

    res.json(rows)
  })
)

// ✅ POST documentos (sube a S3 y guarda en DB)
// FormData esperado:
// - document_type (o documentType / type)
// - file (puede venir repetido para múltiples)
router.post(
  "/:treatmentId/documentos",
  upload.array("file", 10),
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })

    const docsTableExists = await hasTable("service_documents")
    if (!docsTableExists) {
      return res.status(500).json({
        error: "Ocurrió un error en el servidor",
        details: "Table 'service_documents' doesn't exist",
      })
    }

    // valida pertenencia del tratamiento al paciente
    const [[own]] = await db.query(
      `SELECT id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
      [treatmentId, patientId]
    )
    if (!own) return res.status(404).json({ error: "Tratamiento no encontrado." })

    // acepta varias llaves por si tu front manda diferente
    const rawType =
      req.body?.document_type ?? req.body?.documentType ?? req.body?.type ?? ""

    const documentType = normalizeDocType(rawType)
    if (!documentType || !VALID_DOC_TYPES.includes(documentType)) {
      return res.status(400).json({
        error: "document_type inválido",
        valid: VALID_DOC_TYPES,
        received: rawType,
      })
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No se ha subido ningún archivo." })
    }

    const createdAtRaw = req.body?.created_at
    const createdAt = createdAtRaw ? new Date(createdAtRaw) : new Date()
    if (Number.isNaN(createdAt.getTime())) {
      return res.status(400).json({ error: "created_at inválido" })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // 1) subir a S3
      const uploadedUrls = []
      for (const file of req.files) {
        const key = buildS3Key({
          patientId,
          treatmentId,
          docType: documentType,
          originalname: file.originalname,
        })
        const url = await uploadFileToS3({ key, file })
        uploadedUrls.push(url)

        // 2) guardar en DB
        await conn.query(
          `
          INSERT INTO service_documents
            (patient_service_id, document_type, file_url, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, NOW())
          `,
          [treatmentId, documentType, url, createdAt]
        )
      }

      await conn.commit()

      // respuesta: lista actualizada
      const [rows] = await db.query(
        `
        SELECT id, patient_service_id, document_type, file_url, created_at, updated_at
        FROM service_documents
        WHERE patient_service_id = ?
        ORDER BY created_at DESC, id DESC
        `,
        [treatmentId]
      )

      res.status(201).json(rows)
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)

// ✅ DELETE documento (opcional, por si quieres moverlo aquí)
// Endpoint sugerido:
// DELETE /api/pacientes/:patientId/tratamientos/documentos/:docId
// DELETE /api/pacientes/:patientId/tratamientos/:treatmentId/documentos/:docId
router.delete(
  "/:treatmentId/documentos/:docId",
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)
    const docId = toNumber(req.params.docId)

    if (!patientId) return res.status(400).json({ error: "patientId inválido" })
    if (!treatmentId) return res.status(400).json({ error: "treatmentId inválido" })
    if (!docId) return res.status(400).json({ error: "docId inválido" })

    const docsTableExists = await hasTable("service_documents")
    if (!docsTableExists) return res.status(404).json({ error: "Documento no encontrado." })

    // 1) valida que el documento pertenezca al treatment y al paciente
    const [[doc]] = await db.query(
      `
      SELECT d.id, d.file_url
      FROM service_documents d
      JOIN patient_services ps ON ps.id = d.patient_service_id
      WHERE d.id = ?
        AND d.patient_service_id = ?
        AND ps.patient_id = ?
      LIMIT 1
      `,
      [docId, treatmentId, patientId]
    )

    if (!doc) return res.status(404).json({ error: "Documento no encontrado." })

    // 2) borra en S3 (si se puede obtener el key)
    const key = extractS3KeyFromUrl(doc.file_url)
    if (key) {
      await s3.deleteObject({ Bucket: S3_BUCKET, Key: key }).promise()
    }

    // 3) borra en DB
    await db.query(`DELETE FROM service_documents WHERE id = ?`, [docId])

    res.json({ message: "Documento eliminado exitosamente." })
  })
)

router.get(
  '/:treatmentId/comentarios',
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)
    if (!patientId) return res.status(400).json({ error: 'patientId inválido' })
    if (!treatmentId) return res.status(400).json({ error: 'treatmentId inválido' })

    const commentsTableExists = await hasTable('patient_treatment_comments')
    const mediaTableExists = await hasTable('patient_treatment_comment_media')
    if (!commentsTableExists) return res.json([])

    // valida pertenencia
    const [[own]] = await db.query(
      `SELECT id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
      [treatmentId, patientId]
    )
    if (!own) return res.status(404).json({ error: 'Tratamiento no encontrado.' })

    // comentarios + media como subquery (más fácil)
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.patient_id,
        c.patient_service_group_id AS group_id,
        c.patient_service_id AS treatment_id,
        COALESCE(c.teeth_ids, JSON_ARRAY()) AS teeth_ids,
        c.comment_html,
        c.created_by,
        c.created_at,
        c.updated_at,
        ${
          mediaTableExists
            ? `(SELECT COALESCE(
                  JSON_ARRAYAGG(
                    JSON_OBJECT(
                      'id', m.id,
                      'file_url', m.file_url,
                      'mime_type', m.mime_type,
                      'original_name', m.original_name,
                      'size_bytes', m.size_bytes,
                      'created_at', m.created_at
                    )
                  ),
                  JSON_ARRAY()
                )
                FROM patient_treatment_comment_media m
                WHERE m.comment_id = c.id
              ) AS media`
            : `JSON_ARRAY() AS media`
        }
      FROM patient_treatment_comments c
      WHERE c.patient_id = ? AND c.patient_service_id = ?
      ORDER BY c.created_at DESC, c.id DESC
      `,
      [patientId, treatmentId]
    )

    res.json(rows)
  })
)

router.post(
  '/:treatmentId/comentarios',
  upload.array('file', 10),
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)
    if (!patientId) return res.status(400).json({ error: 'patientId inválido' })
    if (!treatmentId) return res.status(400).json({ error: 'treatmentId inválido' })

    const commentsTableExists = await hasTable('patient_treatment_comments')
    const mediaTableExists = await hasTable('patient_treatment_comment_media')
    if (!commentsTableExists) {
      return res.status(500).json({ error: "Table 'patient_treatment_comments' doesn't exist" })
    }

    // valida pertenencia + saca group_id real del treatment
    const [[own]] = await db.query(
      `SELECT id, group_id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
      [treatmentId, patientId]
    )
    if (!own) return res.status(404).json({ error: 'Tratamiento no encontrado.' })

    const groupId = own?.group_id ? Number(own.group_id) : null

    const commentHtml =
      req.body?.comment_html ?? req.body?.comment ?? req.body?.html ?? null

    const teethRaw = req.body?.teeth_ids ?? req.body?.teeth ?? undefined
    const teethParsed = parseJsonArray(teethRaw)
    const teethCodes = normalizeToothCodes(teethParsed) // reutiliza tu helper

    const hasText = isQuillHtmlMeaningful(commentHtml)
    const hasFiles = Array.isArray(req.files) && req.files.length > 0

    if (!hasText && !hasFiles) {
      return res.status(400).json({ error: 'El comentario está vacío (sin texto ni evidencias).' })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // 1) insertar comentario
      const [ins] = await conn.query(
        `
        INSERT INTO patient_treatment_comments
          (patient_id, patient_service_group_id, patient_service_id, comment_html, teeth_ids, created_by, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [
          patientId,
          groupId,
          treatmentId,
          commentHtml || null,
          teethCodes?.length ? JSON.stringify(teethCodes) : JSON.stringify([]),
          req.user?.id ?? null,
        ]
      )

      const commentId = ins.insertId

      // 2) subir archivos y guardar media
      if (hasFiles) {
        if (!mediaTableExists) {
          throw new Error("Table 'patient_treatment_comment_media' doesn't exist")
        }

        for (const file of req.files) {
          const key = buildCommentS3Key({
            patientId,
            treatmentId,
            commentId,
            originalname: file.originalname,
          })
          const url = await uploadFileToS3({ key, file })

          await conn.query(
            `
            INSERT INTO patient_treatment_comment_media
              (comment_id, file_url, mime_type, original_name, size_bytes, created_at)
            VALUES
              (?, ?, ?, ?, ?, NOW())
            `,
            [
              commentId,
              url,
              file.mimetype || null,
              file.originalname || null,
              Number(file.size || 0) || null,
            ]
          )
        }
      }

      await conn.commit()

      // 3) responder comentario creado con media
      const [created] = await db.query(
        `
        SELECT
          c.id,
          c.patient_id,
          c.patient_service_group_id AS group_id,
          c.patient_service_id AS treatment_id,
          COALESCE(c.teeth_ids, JSON_ARRAY()) AS teeth_ids,
          c.comment_html,
          c.created_by,
          c.created_at,
          c.updated_at,
          (SELECT COALESCE(
              JSON_ARRAYAGG(
                JSON_OBJECT(
                  'id', m.id,
                  'file_url', m.file_url,
                  'mime_type', m.mime_type,
                  'original_name', m.original_name,
                  'size_bytes', m.size_bytes,
                  'created_at', m.created_at
                )
              ),
              JSON_ARRAY()
            )
            FROM patient_treatment_comment_media m
            WHERE m.comment_id = c.id
          ) AS media
        FROM patient_treatment_comments c
        WHERE c.id = ?
        LIMIT 1
        `,
        [commentId]
      )

      res.status(201).json(created?.[0] ?? null)
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)

router.delete(
  '/:treatmentId/comentarios/:commentId',
  asyncHandler(async (req, res) => {
    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)
    const commentId = toNumber(req.params.commentId)

    if (!patientId) return res.status(400).json({ error: 'patientId inválido' })
    if (!treatmentId) return res.status(400).json({ error: 'treatmentId inválido' })
    if (!commentId) return res.status(400).json({ error: 'commentId inválido' })

    const commentsTableExists = await hasTable('patient_treatment_comments')
    const mediaTableExists = await hasTable('patient_treatment_comment_media')
    if (!commentsTableExists) return res.status(404).json({ error: 'Comentario no encontrado.' })

    const conn = await db.getConnection()
    let s3Keys = []

    try {
      await conn.beginTransaction()

      // ✅ valida pertenencia + lock
      const [[own]] = await conn.query(
        `
        SELECT id
        FROM patient_treatment_comments
        WHERE id = ? AND patient_id = ? AND patient_service_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [commentId, patientId, treatmentId]
      )
      if (!own) {
        await conn.rollback()
        return res.status(404).json({ error: 'Comentario no encontrado.' })
      }

      // ✅ toma llaves S3 (sin borrar aún)
      if (mediaTableExists) {
        const [media] = await conn.query(
          `SELECT file_url FROM patient_treatment_comment_media WHERE comment_id = ?`,
          [commentId]
        )

        s3Keys = (media || [])
          .map((m) => extractS3KeyFromUrl(m.file_url))
          .filter(Boolean)

        // borra media rows (por si NO hay cascade)
        await conn.query(
          `DELETE FROM patient_treatment_comment_media WHERE comment_id = ?`,
          [commentId]
        )
      }

      // borra comentario
      const [del] = await conn.query(
        `DELETE FROM patient_treatment_comments WHERE id = ? AND patient_id = ? AND patient_service_id = ?`,
        [commentId, patientId, treatmentId]
      )

      if (!del.affectedRows) {
        await conn.rollback()
        return res.status(404).json({ error: 'Comentario no encontrado.' })
      }

      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }

    // ✅ S3 cleanup “best-effort” (no rompe la respuesta)
    if (s3Keys.length) {
      Promise.allSettled(
        s3Keys.map((Key) => s3.deleteObject({ Bucket: S3_BUCKET, Key }).promise())
      ).then((results) => {
        const failed = results.filter((r) => r.status === 'rejected')
        if (failed.length) {
          console.error('S3 delete failed:', failed.length)
        }
      })
    }

    res.json({ ok: true })
  })
)

router.patch(
  '/:treatmentId/comentarios/:commentId',
  commentUpload,
  asyncHandler(async (req, res) => {
    const files = collectFiles(req)
    const hasNewFiles = Array.isArray(files) && files.length > 0

    const patientId = toNumber(req.params.patientId)
    const treatmentId = toNumber(req.params.treatmentId)
    const commentId = toNumber(req.params.commentId)

    if (!patientId) return res.status(400).json({ error: 'patientId inválido' })
    if (!treatmentId) return res.status(400).json({ error: 'treatmentId inválido' })
    if (!commentId) return res.status(400).json({ error: 'commentId inválido' })

    const commentsTableExists = await hasTable('patient_treatment_comments')
    const mediaTableExists = await hasTable('patient_treatment_comment_media')
    if (!commentsTableExists) return res.status(404).json({ error: 'Comentario no encontrado.' })

    // valida pertenencia del tratamiento al paciente
    const [[ownTreatment]] = await db.query(
      `SELECT id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1`,
      [treatmentId, patientId]
    )
    if (!ownTreatment) return res.status(404).json({ error: 'Tratamiento no encontrado.' })

    // inputs
    const rawHtml =
      req.body?.comment_html ?? req.body?.comment ?? req.body?.html ?? undefined

    const rawTeeth = req.body?.teeth_ids ?? req.body?.teeth ?? undefined

    const rawRemove = req.body?.remove_media_ids ?? req.body?.removeMediaIds ?? undefined

    const teethParsed = rawTeeth !== undefined ? parseJsonArray(rawTeeth) : undefined
    const teethCodes =
      teethParsed !== undefined ? normalizeToothCodes(teethParsed) : undefined

    const removeParsed = rawRemove !== undefined ? parseJsonArray(rawRemove) : undefined
    const removeIds = Array.isArray(removeParsed)
      ? removeParsed.map(toInt).filter((n) => n != null)
      : undefined

    const wantsRemove = Array.isArray(removeIds) && removeIds.length > 0
    const wantsHtmlUpdate = rawHtml !== undefined
    const wantsTeethUpdate = rawTeeth !== undefined

    // si quieren subir/borrar media pero la tabla no existe
    if ((hasNewFiles || wantsRemove) && !mediaTableExists) {
      return res.status(500).json({
        error: "Table 'patient_treatment_comment_media' doesn't exist",
      })
    }

    const conn = await db.getConnection()
    let s3KeysToDelete = []

    try {
      await conn.beginTransaction()

      // ✅ lock del comentario + valida pertenencia
      const [[prev]] = await conn.query(
        `
        SELECT id, comment_html, COALESCE(teeth_ids, JSON_ARRAY()) AS teeth_ids
        FROM patient_treatment_comments
        WHERE id = ? AND patient_id = ? AND patient_service_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [commentId, patientId, treatmentId]
      )

      if (!prev) {
        await conn.rollback()
        return res.status(404).json({ error: 'Comentario no encontrado.' })
      }

      // 1) eliminar media seleccionada (DB) + preparar borrado S3
      if (wantsRemove) {
        // trae urls que sí pertenezcan al comment
        const placeholders = removeIds.map(() => '?').join(',')
        const [rows] = await conn.query(
          `
          SELECT id, file_url
          FROM patient_treatment_comment_media
          WHERE comment_id = ?
            AND id IN (${placeholders})
          `,
          [commentId, ...removeIds]
        )

        s3KeysToDelete = (rows || [])
          .map((r) => extractS3KeyFromUrl(r.file_url))
          .filter(Boolean)

        // borra solo los que existan
        if (rows.length) {
          await conn.query(
            `
            DELETE FROM patient_treatment_comment_media
            WHERE comment_id = ?
              AND id IN (${placeholders})
            `,
            [commentId, ...removeIds]
          )
        }
      }

      // 2) subir nuevos archivos + guardar media
      if (hasNewFiles) {
      for (const file of files) {
          const key = buildCommentS3Key({
            patientId,
            treatmentId,
            commentId,
            originalname: file.originalname,
          })
          const url = await uploadFileToS3({ key, file })

          await conn.query(
            `
            INSERT INTO patient_treatment_comment_media
              (comment_id, file_url, mime_type, original_name, size_bytes, created_at)
            VALUES
              (?, ?, ?, ?, ?, NOW())
            `,
            [
              commentId,
              url,
              file.mimetype || null,
              file.originalname || null,
              Number(file.size || 0) || null,
            ]
          )
        }
      }

      // 3) preparar update de comment (html + teeth)
      const sets = []
      const values = []

      if (wantsHtmlUpdate) {
        // si viene vacío tipo "<p><br></p>" lo guardamos como null
        const meaningful = isQuillHtmlMeaningful(rawHtml)
        sets.push('comment_html = ?')
        values.push(meaningful ? String(rawHtml) : null)
      }

      if (wantsTeethUpdate) {
        sets.push('teeth_ids = ?')
        values.push(JSON.stringify(teethCodes?.length ? teethCodes : []))
      }

      const touched =
        wantsHtmlUpdate || wantsTeethUpdate || hasNewFiles || wantsRemove

      if (touched) {
        sets.push('updated_at = NOW()')
      }

      if (sets.length) {
        values.push(commentId, patientId, treatmentId)
        await conn.query(
          `
          UPDATE patient_treatment_comments
          SET ${sets.join(', ')}
          WHERE id = ? AND patient_id = ? AND patient_service_id = ?
          `,
          values
        )
      }

      // 4) validación final: no permitir comentario “vacío” (sin texto y sin media)
      //    (solo si tocaron algo)
      if (touched) {
        // html final:
        const [[finalRow]] = await conn.query(
          `
          SELECT comment_html
          FROM patient_treatment_comments
          WHERE id = ? AND patient_id = ? AND patient_service_id = ?
          LIMIT 1
          `,
          [commentId, patientId, treatmentId]
        )

        let mediaCount = 0
        if (mediaTableExists) {
          const [[cnt]] = await conn.query(
            `SELECT COUNT(*) AS c FROM patient_treatment_comment_media WHERE comment_id = ?`,
            [commentId]
          )
          mediaCount = Number(cnt?.c || 0)
        }

        const hasText = isQuillHtmlMeaningful(finalRow?.comment_html)

        if (!hasText && mediaCount === 0) {
          await conn.rollback()
          return res.status(400).json({
            error: 'El comentario no puede quedar vacío (sin texto ni evidencias).',
          })
        }
      }

      await conn.commit()

      // 5) responder comentario actualizado (con media)
      const [updated] = await db.query(
        `
        SELECT
          c.id,
          c.patient_id,
          c.patient_service_group_id AS group_id,
          c.patient_service_id AS treatment_id,
          COALESCE(c.teeth_ids, JSON_ARRAY()) AS teeth_ids,
          c.comment_html,
          c.created_by,
          c.created_at,
          c.updated_at,
          ${
            mediaTableExists
              ? `(SELECT COALESCE(
                    JSON_ARRAYAGG(
                      JSON_OBJECT(
                        'id', m.id,
                        'file_url', m.file_url,
                        'mime_type', m.mime_type,
                        'original_name', m.original_name,
                        'size_bytes', m.size_bytes,
                        'created_at', m.created_at
                      )
                    ),
                    JSON_ARRAY()
                  )
                  FROM patient_treatment_comment_media m
                  WHERE m.comment_id = c.id
                ) AS media`
              : `JSON_ARRAY() AS media`
          }
        FROM patient_treatment_comments c
        WHERE c.id = ?
        LIMIT 1
        `,
        [commentId]
      )

      // ✅ cleanup S3 “best-effort”
      if (s3KeysToDelete.length) {
        Promise.allSettled(
          s3KeysToDelete.map((Key) =>
            s3.deleteObject({ Bucket: S3_BUCKET, Key }).promise()
          )
        ).then((results) => {
          const failed = results.filter((r) => r.status === 'rejected')
          if (failed.length) console.error('S3 delete failed:', failed.length)
        })
      }

      res.json(updated?.[0] ?? null)
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
)




module.exports = router
