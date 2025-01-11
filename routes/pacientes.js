const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Obtener todos los pacientes
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM pacientes');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener los pacientes' });
  }
});

// Obtener un paciente por ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query('SELECT * FROM pacientes WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener el paciente' });
  }
});

// Crear un nuevo paciente
router.post('/', async (req, res) => {
  const { nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil } = req.body;
  try {
    const [result] = await db.query(
      'INSERT INTO pacientes (nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil]
    );
    res.status(201).json({ id: result.insertId, message: 'Paciente creado exitosamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al crear el paciente' });
  }
});

// Actualizar un paciente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil } = req.body;
  try {
    const [result] = await db.query(
      'UPDATE pacientes SET nombre = ?, apellidos = ?, telefono = ?, fecha_nacimiento = ?, email = ?, direccion = ?, foto_perfil = ? WHERE id = ?',
      [nombre, apellidos, telefono, fecha_nacimiento, email, direccion, foto_perfil, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json({ message: 'Paciente actualizado exitosamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al actualizar el paciente' });
  }
});

// Eliminar un paciente
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query('DELETE FROM pacientes WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado' });
    }
    res.json({ message: 'Paciente eliminado exitosamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al eliminar el paciente' });
  }
});

module.exports = router;
