// routes/payments.js
const express = require('express');
const router = express.Router({ mergeParams: true }); // <- necesitamos mergeParams
const db = require('../config/db');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ————————————————————————————————
// 1) Obtener pagos + saldo de un paciente
//    GET /api/pacientes/:patientId/pagos
// ————————————————————————————————
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const query = `
      SELECT
        pp.id,
        pp.fecha,
        pp.patient_service_id,
        s.name               AS tratamiento,
        sv.total_cost,
        pp.monto,
        IFNULL(pagg.total_pagado, 0) AS total_pagado,
        (sv.total_cost - IFNULL(pagg.total_pagado, 0)) AS saldo_pendiente,
        pm.id               AS payment_method_id,
        pm.name             AS metodo_pago,
        ps.id               AS payment_status_id,
        ps.name             AS estado,
        pp.numero_factura,
        pp.notas,
        pp.created_at,
        pp.updated_at
      FROM patient_payments pp
      LEFT JOIN patient_services sv
        ON sv.id = pp.patient_service_id
      LEFT JOIN services s
        ON s.id = sv.service_id
      LEFT JOIN (
        SELECT
          patient_service_id,
          SUM(monto) AS total_pagado
        FROM patient_payments
        WHERE patient_service_id IS NOT NULL
        GROUP BY patient_service_id
      ) AS pagg
        ON pagg.patient_service_id = pp.patient_service_id
      LEFT JOIN payment_methods pm
        ON pm.id = pp.payment_method_id
      LEFT JOIN payment_statuses ps
        ON ps.id = pp.payment_status_id
      WHERE pp.patient_id = ?
      ORDER BY pp.fecha DESC
    `;
    const [rows] = await db.query(query, [patientId]);
    res.json(rows);
  })
);

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

    // 1) Si no envían payment_status_id, buscamos el id de "finalizado"
    let payment_status_id = rawStatusId
    if (!payment_status_id) {
      const [statusRows] = await db.query(
        'SELECT id FROM payment_statuses WHERE name = ? LIMIT 1',
        ['finalizado']
      )
      payment_status_id = statusRows.length
        ? statusRows[0].id
        : 1 // fallback si no existe el registro, usas 1 como genérico
    }

    // 2) (Opcional) default para payment_method_id
    let pmId = payment_method_id
    if (!pmId) {
      const [methodRows] = await db.query(
        'SELECT id FROM payment_methods WHERE name = ? LIMIT 1',
        ['efectivo']
      )
      pmId = methodRows.length
        ? methodRows[0].id
        : null
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
      patient_service_id,
      fecha,
      parseFloat(monto),
      pmId,
      payment_status_id,
      invoiceNumber,
      notas || null,
    ])

    // Devuelve el registro recién creado con sus joins…
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
    const { id, patientId } = req.params;
    let {
      fecha,
      patient_service_id,
      monto,
      payment_method_id,
      payment_status_id,
      notas,
      estado
    } = req.body;

    // Traducir estado a payment_status_id si envían nombre
    if (!payment_status_id && estado) {
      const [rows] = await db.query(
        'SELECT id FROM payment_statuses WHERE name = ?',
        [estado]
      );
      if (!rows.length) {
        return res.status(400).json({ error: `Estado desconocido: ${estado}` });
      }
      payment_status_id = rows[0].id;
    }

    // Traducir metodo_pago a payment_method_id si envían nombre
    if (!payment_method_id && req.body.metodo_pago) {
      const [mrows] = await db.query(
        'SELECT id FROM payment_methods WHERE name = ?',
        [req.body.metodo_pago]
      );
      if (!mrows.length) {
        return res.status(400).json({ error: `Método desconocido: ${req.body.metodo_pago}` });
      }
      payment_method_id = mrows[0].id;
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
      WHERE id = ?
    `;
    const [result] = await db.query(updateSql, [
      fecha,
      patient_service_id,
      parseFloat(monto),
      payment_method_id,
      payment_status_id,
      notas,
      id
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pago no encontrado.' });
    }
    res.json({ message: 'Pago actualizado exitosamente.' });
  })
);

// ————————————————————————————————
// 4) Eliminar pago
//    DELETE /api/pacientes/:patientId/pagos/:id
// ————————————————————————————————
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [result] = await db.query(
      'DELETE FROM patient_payments WHERE id = ?',
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pago no encontrado.' });
    }
    res.json({ message: 'Pago eliminado exitosamente.' });
  })
);

module.exports = router;
