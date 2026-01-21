// routes/payments.js
const express = require('express')
const router = express.Router({ mergeParams: true })
const db = require('../config/db')
const { logPatientEvent } = require('../utils/logPatientEvent')

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

// ✅ logging seguro: si falla, NO rompe la request
async function safeLogEvent(payload) {
  try {
    await logPatientEvent(payload)
  } catch (err) {
    console.error('⚠️ No se pudo registrar patient_treatment_event:', err?.message || err)
  }
}

// ————————————————————————————————
// 1) Obtener pagos + saldo de un paciente
//    GET /api/pacientes/:patientId/pagos
// ————————————————————————————————
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params

    const query = `
      SELECT
        pp.id,
        pp.fecha,
        pp.patient_service_id,

        -- ✅ grupo
        sv.group_id,
        gstart.group_start_date,

        s.name AS tratamiento,
        sv.total_cost,
        pp.monto,

        IFNULL(pagg.total_pagado, 0) AS total_pagado,
        (sv.total_cost - IFNULL(pagg.total_pagado, 0)) AS saldo_pendiente,

        pm.id   AS payment_method_id,
        pm.name AS metodo_pago,
        ps.id   AS payment_status_id,
        ps.name AS estado,

        pp.numero_factura,
        pp.notas,
        pp.created_at,
        pp.updated_at

      FROM patient_payments pp
      LEFT JOIN patient_services sv ON sv.id = pp.patient_service_id
      LEFT JOIN services s ON s.id = sv.service_id

      -- total pagado por servicio
      LEFT JOIN (
        SELECT patient_service_id, SUM(monto) AS total_pagado
        FROM patient_payments
        WHERE patient_service_id IS NOT NULL
        GROUP BY patient_service_id
      ) pagg ON pagg.patient_service_id = pp.patient_service_id

      LEFT JOIN payment_methods pm ON pm.id = pp.payment_method_id
      LEFT JOIN payment_statuses ps ON ps.id = pp.payment_status_id

      -- ✅ startDate del grupo (mínima service_date del grupo)
      LEFT JOIN (
        SELECT
          sv2.group_id,
          MIN(sv2.service_date) AS group_start_date
        FROM patient_services sv2
        WHERE sv2.group_id IS NOT NULL
        GROUP BY sv2.group_id
      ) gstart ON gstart.group_id = sv.group_id

      -- ✅ última actividad del grupo (máximo created_at de pagos del grupo)
      LEFT JOIN (
        SELECT
          sv3.group_id,
          MAX(pp3.created_at) AS group_last_activity
        FROM patient_payments pp3
        JOIN patient_services sv3 ON sv3.id = pp3.patient_service_id
        WHERE pp3.patient_id = ?
          AND sv3.group_id IS NOT NULL
        GROUP BY sv3.group_id
      ) glast ON glast.group_id = sv.group_id

      WHERE pp.patient_id = ?

      ORDER BY
        (sv.group_id IS NULL) ASC,                         -- grupos primero
        glast.group_last_activity DESC,                    -- grupo más "reciente" arriba
        sv.group_id DESC,                                  -- desempate por id de grupo
        pp.created_at DESC                                 -- dentro del grupo, pagos más recientes arriba
    `

    const [rows] = await db.query(query, [patientId, patientId])
    res.json(rows)
  })
)


// ————————————————————————————————
// 2) Crear nuevo pago
//    POST /api/pacientes/:patientId/pagos
// ————————————————————————————————
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params
    const {
      fecha,
      patient_service_id,
      monto,
      payment_method_id,
      payment_status_id: rawStatusId,
      notas,
    } = req.body

    // 1) default payment_status_id = "finalizado"
    let payment_status_id = rawStatusId
    if (!payment_status_id) {
      const [statusRows] = await db.query(
        'SELECT id FROM payment_statuses WHERE name = ? LIMIT 1',
        ['finalizado']
      )
      payment_status_id = statusRows.length ? statusRows[0].id : 1
    }

    // 2) default payment_method_id = "efectivo"
    let pmId = payment_method_id
    if (!pmId) {
      const [methodRows] = await db.query(
        'SELECT id FROM payment_methods WHERE name = ? LIMIT 1',
        ['efectivo']
      )
      pmId = methodRows.length ? methodRows[0].id : null
    }

    const invoiceNumber = `F-${Date.now()}`

    const insertSql = `
      INSERT INTO patient_payments (
        patient_id,
        patient_service_id,
        fecha,
        monto,
        payment_method_id,
        payment_status_id,
        numero_factura,
        notas,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `

    const [ins] = await db.query(insertSql, [
      patientId,
      patient_service_id || null,
      fecha,
      parseFloat(monto),
      pmId,
      payment_status_id,
      invoiceNumber,
      notas || null,
    ])

    // ✅ Log del evento (NO bloquea si falla)
    await safeLogEvent({
      patientId: Number(patientId),
      patientServiceId: patient_service_id ? Number(patient_service_id) : null,
      eventType: 'payment_created',
      message: `Pago registrado por $${Number(monto || 0)} (factura: ${invoiceNumber})`,
      meta: {
        payment_id: ins.insertId,
        monto: Number(monto || 0),
        fecha,
        payment_method_id: pmId,
        payment_status_id,
        numero_factura: invoiceNumber,
        notas: notas ?? null,
      },
      createdBy: req.user?.id ?? null,
    })

    // Devuelve el registro recién creado con joins
    const [rows] = await db.query(
      `SELECT
         pp.id,
         pp.fecha,
         pp.patient_service_id,
         s.name                AS tratamiento,
         sv.total_cost,
         IFNULL(pagg.total_pagado, 0)       AS total_pagado,
         (sv.total_cost - IFNULL(pagg.total_pagado, 0)) AS saldo_pendiente,
         pm.name               AS metodo_pago,
         ps.name               AS estado,
         pp.numero_factura,
         pp.notas
       FROM patient_payments pp
       LEFT JOIN patient_services sv  ON sv.id = pp.patient_service_id
       LEFT JOIN services s           ON s.id  = sv.service_id
       LEFT JOIN (
         SELECT patient_service_id, SUM(monto) AS total_pagado
         FROM patient_payments
         WHERE patient_service_id IS NOT NULL
         GROUP BY patient_service_id
       ) AS pagg ON pagg.patient_service_id = pp.patient_service_id
       LEFT JOIN payment_methods pm ON pm.id = pp.payment_method_id
       LEFT JOIN payment_statuses ps ON ps.id = pp.payment_status_id
       WHERE pp.id = ?`,
      [ins.insertId]
    )

    res.status(201).json(rows[0])
  })
)

// ————————————————————————————————
// 3) Actualizar pago
//    PUT /api/pacientes/:patientId/pagos/:id
// ————————————————————————————————
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id, patientId } = req.params
    let {
      fecha,
      patient_service_id,
      monto,
      payment_method_id,
      payment_status_id,
      notas,
      estado,
    } = req.body

    // (opcional) trae el pago actual para loggear antes/después o rescatar service_id
    const [beforeRows] = await db.query(
      'SELECT id, patient_service_id, fecha, monto, payment_method_id, payment_status_id, numero_factura, notas FROM patient_payments WHERE id = ? AND patient_id = ? LIMIT 1',
      [id, patientId]
    )
    if (!beforeRows.length) {
      return res.status(404).json({ error: 'Pago no encontrado.' })
    }
    const before = beforeRows[0]

    // Traducir estado a payment_status_id si envían nombre
    if (!payment_status_id && estado) {
      const [rows] = await db.query(
        'SELECT id FROM payment_statuses WHERE name = ?',
        [estado]
      )
      if (!rows.length) {
        return res.status(400).json({ error: `Estado desconocido: ${estado}` })
      }
      payment_status_id = rows[0].id
    }

    // Traducir metodo_pago a payment_method_id si envían nombre
    if (!payment_method_id && req.body.metodo_pago) {
      const [mrows] = await db.query(
        'SELECT id FROM payment_methods WHERE name = ?',
        [req.body.metodo_pago]
      )
      if (!mrows.length) {
        return res.status(400).json({ error: `Método desconocido: ${req.body.metodo_pago}` })
      }
      payment_method_id = mrows[0].id
    }

    const updateSql = `
      UPDATE patient_payments
      SET
        fecha              = ?,
        patient_service_id = ?,
        monto              = ?,
        payment_method_id  = ?,
        payment_status_id  = ?,
        notas              = ?,
        updated_at         = NOW()
      WHERE id = ? AND patient_id = ?
    `
    const [result] = await db.query(updateSql, [
      fecha ?? before.fecha,
      patient_service_id ?? before.patient_service_id,
      parseFloat(monto ?? before.monto),
      payment_method_id ?? before.payment_method_id,
      payment_status_id ?? before.payment_status_id,
      notas ?? before.notas,
      id,
      patientId,
    ])

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pago no encontrado.' })
    }

    // ✅ Log evento update
    await safeLogEvent({
      patientId: Number(patientId),
      patientServiceId: Number(patient_service_id ?? before.patient_service_id) || null,
      eventType: 'payment_updated',
      message: `Pago actualizado (ID: ${id})`,
      meta: {
        payment_id: Number(id),
        before,
        after: {
          fecha: fecha ?? before.fecha,
          patient_service_id: patient_service_id ?? before.patient_service_id,
          monto: Number(monto ?? before.monto),
          payment_method_id: payment_method_id ?? before.payment_method_id,
          payment_status_id: payment_status_id ?? before.payment_status_id,
          notas: notas ?? before.notas,
        },
      },
      createdBy: req.user?.id ?? null,
    })

    res.json({ message: 'Pago actualizado exitosamente.' })
  })
)

// ————————————————————————————————
// 4) Eliminar pago
//    DELETE /api/pacientes/:patientId/pagos/:id
// ————————————————————————————————
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id, patientId } = req.params

    // ✅ leer antes de borrar para log correcto (y recuperar patient_service_id)
    const [rows] = await db.query(
      'SELECT id, patient_service_id, fecha, monto, payment_method_id, payment_status_id, numero_factura, notas FROM patient_payments WHERE id = ? AND patient_id = ? LIMIT 1',
      [id, patientId]
    )
    if (!rows.length) {
      return res.status(404).json({ error: 'Pago no encontrado.' })
    }
    const before = rows[0]

    const [result] = await db.query(
      'DELETE FROM patient_payments WHERE id = ? AND patient_id = ?',
      [id, patientId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pago no encontrado.' })
    }

    // ✅ Log delete
    await safeLogEvent({
      patientId: Number(patientId),
      patientServiceId: Number(before.patient_service_id) || null,
      eventType: 'payment_deleted',
      message: `Pago eliminado (ID: ${id})`,
      meta: { payment_id: Number(id), before },
      createdBy: req.user?.id ?? null,
    })

    res.json({ message: 'Pago eliminado exitosamente.' })
  })
)

module.exports = router
