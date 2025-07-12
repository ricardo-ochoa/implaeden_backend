// routes/citas.js
const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Middleware para manejar errores de forma asíncrona\
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ————————————————————————————————
// Rutas para gestión de citas de un paciente
// ————————————————————————————————

// 1) Listar todas las citas de un paciente
router.get('/:patientId/citas', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const query = `
    SELECT
      c.id,
      c.appointment_at,
      c.service_id,
      s.name AS tratamiento,
      c.observaciones,
      c.created_at,
      c.updated_at
    FROM citas c
    LEFT JOIN services s ON s.id = c.service_id
    WHERE c.patient_id = ?
    ORDER BY c.appointment_at DESC
  `;
  const [rows] = await db.query(query, [patientId]);
  res.json(rows);
}));

// 2) Obtener una cita en particular
router.get('/:patientId/citas/:id', asyncHandler(async (req, res) => {
  const { patientId, id } = req.params;
  const query = `
    SELECT
      c.id,
      c.appointment_at,
      c.service_id,
      s.name AS tratamiento,
      c.observaciones,
      c.created_at,
      c.updated_at
    FROM citas c
    LEFT JOIN services s ON s.id = c.service_id
    WHERE c.patient_id = ? AND c.id = ?
  `;
  const [rows] = await db.query(query, [patientId, id]);
  if (!rows.length) {
    return res.status(404).json({ error: 'Cita no encontrada' });
  }
  res.json(rows[0]);
}));

// 3) Crear una nueva cita
router.post('/:patientId/citas', asyncHandler(async (req, res) => {
  const { patientId } = req.params;
  const { appointment_at, service_id, observaciones } = req.body;
  if (!appointment_at || !service_id) {
    return res.status(400).json({ error: 'Fecha y servicio son obligatorios' });
  }
  const insertSql = `
    INSERT INTO citas (
      patient_id,
      service_id,
      appointment_at,
      observaciones,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, NOW(), NOW())
  `;
  const [result] = await db.query(insertSql, [
    patientId,
    service_id,
    appointment_at,
    observaciones || null
  ]);
  res.status(201).json({ id: result.insertId, message: 'Cita creada exitosamente.' });
}));

// 4) Actualizar una cita existente
router.put('/:patientId/citas/:id', asyncHandler(async (req, res) => {
  const { patientId, id } = req.params;
  const { appointment_at, service_id, observaciones } = req.body;
  const updateSql = `
    UPDATE citas
    SET
      appointment_at = ?,
      service_id     = ?,
      observaciones  = ?,
      updated_at     = NOW()
    WHERE id = ? AND patient_id = ?
  `;
  const [result] = await db.query(updateSql, [
    appointment_at,
    service_id,
    observaciones || null,
    id,
    patientId
  ]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Cita no encontrada o no pertenece al paciente.' });
  }
  res.json({ message: 'Cita actualizada exitosamente.' });
}));

// 5) Eliminar una cita
router.delete('/:patientId/citas/:id', asyncHandler(async (req, res) => {
  const { patientId, id } = req.params;
  const [result] = await db.query(
    'DELETE FROM citas WHERE id = ? AND patient_id = ?',
    [id, patientId]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Cita no encontrada o no pertenece al paciente.' });
  }
  res.json({ message: 'Cita eliminada exitosamente.' });
}));

module.exports = router;
