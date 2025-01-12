const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Obtener todos los pacientes
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM pacientes');
    res.json(rows);
  })
);

// Obtener un paciente por ID
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM pacientes WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json(rows[0]);
  })
);

// Crear un nuevo paciente
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil } = req.body;
    const [result] = await db.query(
      'INSERT INTO pacientes (nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil]
    );
    res.status(201).json({ id: result.insertId, message: 'Paciente creado exitosamente' });
  })
);

// Actualizar un paciente
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil } = req.body;
    const [result] = await db.query(
      'UPDATE pacientes SET nombre = ?, apellidos = ?, telefono = ?, fecha_nacimiento = ?, email = ?, direccion = ?, foto_perfil = ? WHERE id = ?',
      [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json({ message: 'Paciente actualizado exitosamente' });
  })
);

// Eliminar un paciente
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM pacientes WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json({ message: 'Paciente eliminado exitosamente' });
  })
);

module.exports = router;
