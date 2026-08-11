// routes/payments.js
const express = require('express')
const router = express.Router({ mergeParams: true })
const db = require('../config/db')
const { logPatientEvent } = require('../utils/logPatientEvent')
const facturacom = require('../services/facturacom')

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

// Resuelve el id de un catálogo de pagos por NOMBRE, sin distinguir mayúsculas
// (los datos tienen inconsistencias: 'Efectivo' vs 'efectivo'). `table` es un
// literal controlado internamente ('payment_methods' | 'payment_statuses').
async function idByName(table, name) {
  if (!name) return null
  const [rows] = await db.query(
    `SELECT id FROM ${table} WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [String(name).trim()]
  )
  return rows.length ? rows[0].id : null
}

// ————————————————————————————————
// Sync con factura.com (autofacturación). Best-effort: si factura.com no está
// configurado (sin llaves) NO hace nada; si falla, NO rompe la operación de pago.
// El FOLIO de la orden = patient_payments.id.
// ————————————————————————————————
async function syncAutofacCreate(payment) {
  if (!facturacom.isConfigured()) return
  try {
    const { softId } = await facturacom.createOrder(payment)
    await db.query(
      'UPDATE patient_payments SET autofac_soft_id = ?, autofac_status = ?, autofac_synced_at = NOW() WHERE id = ?',
      [softId, softId ? 'loaded' : 'error', payment.id]
    )
  } catch (e) {
    console.warn('facturacom(create):', e.message)
    try {
      await db.query(
        'UPDATE patient_payments SET autofac_status = ?, autofac_synced_at = NOW() WHERE id = ?',
        ['error', payment.id]
      )
    } catch (_) {}
  }
}

async function syncAutofacUpdate(paymentId, patientId) {
  if (!facturacom.isConfigured()) return
  try {
    const [rows] = await db.query(
      `SELECT pp.id, pp.monto, pp.fecha, pm.name AS metodo_pago,
              pp.autofac_soft_id, pp.autofac_status
         FROM patient_payments pp
         LEFT JOIN payment_methods pm ON pm.id = pp.payment_method_id
        WHERE pp.id = ? AND pp.patient_id = ? LIMIT 1`,
      [paymentId, patientId]
    )
    const p = rows[0]
    if (!p) return
    if (p.autofac_status === 'invoiced') return          // ya facturada: no se toca
    if (!p.autofac_soft_id) return syncAutofacCreate(p)  // aún no cargada: crearla
    const order = facturacom.buildOrder(p)
    const { ok } = await facturacom.updateOrder(order.folio, {
      importe: order.importe,
      fecha: order.fecha,
      vencimiento: order.vencimiento,
      iva: order.iva,
      formaDePago: order.formaDePago,
    })
    await db.query(
      'UPDATE patient_payments SET autofac_status = ?, autofac_synced_at = NOW() WHERE id = ?',
      [ok ? 'loaded' : 'error', paymentId]
    )
  } catch (e) {
    console.warn('facturacom(update):', e.message)
  }
}

async function syncAutofacDelete(before) {
  if (!facturacom.isConfigured()) return
  if (before?.autofac_status === 'invoiced') return // no borrar orden ya facturada
  try {
    await facturacom.deleteOrder(facturacom.folioFor(before.id))
  } catch (e) {
    console.warn('facturacom(delete):', e.message)
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
      estado,        // alternativa: nombre del estado
      metodo_pago,   // alternativa: nombre del método
      notas,
    } = req.body

    // ── Validación: monto > 0 ─────────────────────────────────────────────
    const montoNum = Number(monto)
    if (!Number.isFinite(montoNum) || montoNum <= 0) {
      return res.status(400).json({ error: 'El monto debe ser un número mayor a 0.' })
    }

    // ── Validación: el tratamiento (si viene) pertenece a ESTE paciente ───
    //    De paso calculamos el saldo previo para (a) derivar el estado y
    //    (b) avisar de sobre-pago. NO bloqueamos el sobre-pago (decisión:
    //    "permitir con aviso"); solo lo señalamos en la respuesta.
    const svcId = patient_service_id ? Number(patient_service_id) : null
    let saldoAntes = null
    if (svcId) {
      const [svRows] = await db.query(
        `SELECT sv.total_cost,
                IFNULL((SELECT SUM(monto) FROM patient_payments WHERE patient_service_id = sv.id), 0) AS pagado
           FROM patient_services sv
          WHERE sv.id = ? AND sv.patient_id = ?
          LIMIT 1`,
        [svcId, patientId]
      )
      if (!svRows.length) {
        return res.status(400).json({ error: 'El tratamiento indicado no pertenece a este paciente.' })
      }
      saldoAntes = Number(svRows[0].total_cost) - Number(svRows[0].pagado)
    }
    const overpay = saldoAntes != null && montoNum - saldoAntes > 0.009

    // ── Estado del pago ───────────────────────────────────────────────────
    //    Prioridad: id explícito > nombre explícito > AUTOMÁTICO por saldo.
    //    Auto: si el abono salda el tratamiento → 'finalizado'; si queda saldo
    //    → 'abono'. Un pago sin tratamiento asociado se marca 'finalizado'.
    let payment_status_id = rawStatusId || (await idByName('payment_statuses', estado))
    if (!payment_status_id) {
      let statusName = 'finalizado'
      if (svcId && saldoAntes != null) {
        statusName = saldoAntes - montoNum > 0.009 ? 'abono' : 'finalizado'
      }
      payment_status_id = (await idByName('payment_statuses', statusName)) || 1
    }

    // ── Método de pago (default 'Efectivo', tolerante a mayúsculas) ───────
    let pmId = payment_method_id || (await idByName('payment_methods', metodo_pago))
    if (!pmId) pmId = await idByName('payment_methods', 'Efectivo')

    const invoiceNumber = `F-${Date.now()}`

    const insertSql = `
      INSERT INTO patient_payments (
        patient_id,
        patient_service_id,
        tratamiento,
        fecha,
        monto,
        payment_method_id,
        payment_status_id,
        numero_factura,
        notas,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `

    const [ins] = await db.query(insertSql, [
      patientId,
      svcId,
      '', // `tratamiento` es columna legacy (NOT NULL sin default); el nombre real se muestra vía join
      fecha,
      montoNum,
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

    // Sync a factura.com — NO bloqueante: nunca demora ni rompe la respuesta del
    // pago (si factura.com está lento/caído, se sincroniza igual en segundo plano).
    syncAutofacCreate({ ...rows[0], monto: montoNum }).catch(() => {})

    // `overpay` avisa al frontend que el pago superó el saldo (no se bloquea).
    res.status(201).json({ ...rows[0], overpay })
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

    // Validación: monto > 0 (solo si viene en el update)
    if (monto !== undefined && monto !== null && monto !== '') {
      const m = Number(monto)
      if (!Number.isFinite(m) || m <= 0) {
        return res.status(400).json({ error: 'El monto debe ser un número mayor a 0.' })
      }
    }

    // Validación: si cambian el tratamiento, que pertenezca a ESTE paciente
    if (patient_service_id != null && Number(patient_service_id) !== Number(before.patient_service_id)) {
      const [svRows] = await db.query(
        'SELECT id FROM patient_services WHERE id = ? AND patient_id = ? LIMIT 1',
        [Number(patient_service_id), patientId]
      )
      if (!svRows.length) {
        return res.status(400).json({ error: 'El tratamiento indicado no pertenece a este paciente.' })
      }
    }

    // Traducir estado (nombre) → payment_status_id, tolerante a mayúsculas
    if (!payment_status_id && estado) {
      payment_status_id = await idByName('payment_statuses', estado)
      if (!payment_status_id) {
        return res.status(400).json({ error: `Estado desconocido: ${estado}` })
      }
    }

    // Traducir metodo_pago (nombre) → payment_method_id, tolerante a mayúsculas
    if (!payment_method_id && req.body.metodo_pago) {
      payment_method_id = await idByName('payment_methods', req.body.metodo_pago)
      if (!payment_method_id) {
        return res.status(400).json({ error: `Método desconocido: ${req.body.metodo_pago}` })
      }
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

    // Sync del cambio a factura.com — NO bloqueante (ver POST).
    syncAutofacUpdate(Number(id), Number(patientId)).catch(() => {})

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
      'SELECT id, patient_service_id, fecha, monto, payment_method_id, payment_status_id, numero_factura, notas, autofac_status FROM patient_payments WHERE id = ? AND patient_id = ? LIMIT 1',
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

    // Borra también la orden en factura.com — NO bloqueante (ver POST).
    syncAutofacDelete(before).catch(() => {})

    res.json({ message: 'Pago eliminado exitosamente.' })
  })
)

module.exports = router
