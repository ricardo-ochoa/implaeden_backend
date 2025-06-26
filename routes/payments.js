const express = require('express');
const router = express.Router();
const db = require('../config/db');

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ————————————————————————————————
// 1) Obtener pagos + saldo de un paciente
// ————————————————————————————————
router.get('/:patientId/pagos', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const query = `
    SELECT
      pwb.id                            AS id,
      pwb.fecha                         AS fecha,
      pwb.tratamiento_id                AS patient_service_id,  -- RENOMBRE correcto
      s.name                            AS tratamiento,
      pwb.total_cost                    AS total_cost,
      pwb.monto                         AS monto,
      pwb.total_pagado                  AS total_pagado,
      pwb.saldo_pendiente               AS saldo_pendiente,
      pwb.estado                        AS estado,
      pwb.numero_factura                AS numero_factura,
      pwb.metodo_pago                   AS metodo_pago,
      pwb.notas                         AS notas
    FROM payments_with_balance pwb
    JOIN patient_services ps   ON ps.id = pwb.tratamiento_id      -- usa el campo real de la vista
    JOIN services s            ON s.id  = ps.service_id
    WHERE pwb.patient_id = ?                                      -- filtra por paciente
    ORDER BY pwb.fecha DESC
  `;
  const [rows] = await db.query(query, [patientId]);
  res.json(rows);
}));

// ————————————————————————————————
// 2) Crear nuevo pago (ahora con FK a treatment)
// ————————————————————————————————
router.post('/:patientId/pagos', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const { fecha, patient_service_id, monto, estado, metodo_pago, notas } = req.body;
  // … validaciones e INSERT …
  const [ins] = await db.query(
    `INSERT INTO patient_payments
      (patient_id, patient_service_id, fecha, monto, estado,
       numero_factura, metodo_pago, notas, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [ patientId, patient_service_id, fecha, parseFloat(monto),
      estado, `F-${Date.now()}`, metodo_pago, notas ]
  );

  // Ahora sí selecciona las columnas con su nombre correcto:
  const [rows] = await db.query(`
    SELECT
      pp.id,
      pp.fecha,
      ps.total_cost,
      s.name         AS tratamiento,
      pp.monto,
      pp.estado,
      pp.numero_factura,
      pp.metodo_pago AS metodo_pago,
      pp.notas       AS notas
    FROM patient_payments pp
    JOIN patient_services ps ON ps.id = pp.patient_service_id
    JOIN services s         ON s.id  = ps.service_id
    WHERE pp.id = ?
  `, [ ins.insertId ]);

  res.status(201).json(rows[0]);
}));

// ————————————————————————————————
// 3) Actualizar pago
// ————————————————————————————————
router.put('/:patientId/pagos/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    fecha,
    patient_service_id,    // <-- también aquí
    monto,
    estado,
    metodo_pago,
    notas
  } = req.body;

  const [result] = await db.query(
    `UPDATE patient_payments
       SET fecha               = ?,
           patient_service_id  = ?,
           monto               = ?,
           estado              = ?,
           metodo_pago         = ?,
           notas               = ?,
           updated_at          = NOW()
     WHERE id = ?`,
    [
      fecha,
      patient_service_id,
      parseFloat(monto),
      estado,
      metodo_pago,
      notas,
      id
    ]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Pago no encontrado.' });
  }

  res.json({ message: 'Pago actualizado exitosamente.' });
}));

// ————————————————————————————————
// 4) Eliminar pago (sin cambios)
// ————————————————————————————————
router.delete('/:patientId/pagos/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [result] = await db.query(
    'DELETE FROM patient_payments WHERE id = ?',
    [id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Pago no encontrado.' });
  }
  res.json({ message: 'Pago eliminado exitosamente.' });
}));

module.exports = router;
