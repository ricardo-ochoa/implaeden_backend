const express = require('express');
const router = express.Router();
const db = require('../config/db');

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Obtener pagos de un paciente
router.get('/:patientId/pagos', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const [rows] = await db.query('SELECT * FROM patient_payments WHERE patient_id = ?', [patientId]);
  res.json(rows);
}));

// Crear nuevo pago
router.post('/:patientId/pagos', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const {
    fecha,
    tratamiento,
    monto,
    estado,
    metodo_pago,
    notas
  } = req.body;

  if (!fecha || !tratamiento || !monto || !estado) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const numeroFactura = `F-${Date.now()}`;

  const [result] = await db.query(
    `INSERT INTO patient_payments 
    (patient_id, fecha, tratamiento, monto, estado, numero_factura, metodo_pago, notas, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [patientId, fecha, tratamiento, parseFloat(monto), estado, numeroFactura, metodo_pago, notas]
  );

  res.status(201).json({ message: 'Pago registrado exitosamente.', id: result.insertId });
}));

// Actualizar pago
router.put('/:patientId/pagos/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    fecha,
    tratamiento,
    monto,
    estado,
    metodo_pago,
    notas
  } = req.body;

  const [result] = await db.query(
    `UPDATE patient_payments 
     SET fecha = ?, tratamiento = ?, monto = ?, estado = ?, metodo_pago = ?, notas = ?, updated_at = NOW() 
     WHERE id = ?`,
    [fecha, tratamiento, parseFloat(monto), estado, metodo_pago, notas, id]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Pago no encontrado.' });
  }

  res.json({ message: 'Pago actualizado exitosamente.' });
}));

// Eliminar pago
router.delete('/:patientId/pagos/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [result] = await db.query('DELETE FROM patient_payments WHERE id = ?', [id]);

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Pago no encontrado.' });
  }

  res.json({ message: 'Pago eliminado exitosamente.' });
}));

module.exports = router;
