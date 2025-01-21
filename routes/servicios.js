const express = require('express');
const router = express.Router();
const db = require('../config/db');

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// **CRUD PARA LA TABLA `services`**

// Obtener todos los servicios
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM services ORDER BY created_at DESC');
    res.json(rows);
  })
);

// Crear un nuevo servicio
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, category, description } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'El nombre y la categoría son obligatorios.' });
    }

    const [result] = await db.query(
      'INSERT INTO services (name, category, description, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [name, category, description]
    );

    res.status(201).json({ message: 'Servicio creado exitosamente.', id: result.insertId });
  })
);

// Actualizar un servicio
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, category, description } = req.body;

    const [result] = await db.query(
      'UPDATE services SET name = ?, category = ?, description = ?, updated_at = NOW() WHERE id = ?',
      [name, category, description, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' });
    }

    res.json({ message: 'Servicio actualizado exitosamente.' });
  })
);

// Eliminar un servicio
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [result] = await db.query('DELETE FROM services WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio no encontrado.' });
    }

    res.json({ message: 'Servicio eliminado exitosamente.' });
  })
);

// **OPERACIONES PARA `patient_services`**

// Obtener servicios relacionados con un paciente
router.get(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const [rows] = await db.query(
      `SELECT ps.id, ps.service_date, ps.notes, s.name, s.category 
       FROM patient_services ps 
       INNER JOIN services s ON ps.service_id = s.id 
       WHERE ps.patient_id = ? 
       ORDER BY ps.service_date DESC`,
      [patientId]
    );
    res.json(rows);
  })
);

router.get(
    '/:id/tratamientos',
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      console.log(`Obteniendo tratamientos para el paciente con ID ${id}`); // Debug
  
      // Consulta SQL para obtener los tratamientos
      const query = `
        SELECT 
          ps.id AS treatment_id, 
          ps.service_date, 
          ps.notes, 
          s.name AS service_name, 
          s.category AS service_category
        FROM patient_services ps
        INNER JOIN services s ON ps.service_id = s.id
        WHERE ps.patient_id = ?
        ORDER BY ps.service_date DESC
      `;
  
      try {
        const [rows] = await db.query(query, [id]);
        console.log('Resultados obtenidos:', rows); // Debug
        res.json(rows);
      } catch (err) {
        console.error('Error al obtener tratamientos:', err);
        res.status(500).json({ error: 'Error al obtener tratamientos del paciente.' });
      }
    })
  );
  

// Asignar un servicio a un paciente
router.post(
  '/patient/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const { service_id, service_date, notes } = req.body;

    if (!service_id || !service_date) {
      return res.status(400).json({ error: 'El ID del servicio y la fecha son obligatorios.' });
    }

    const [result] = await db.query(
      'INSERT INTO patient_services (patient_id, service_id, service_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [patientId, service_id, service_date, notes]
    );

    res.status(201).json({ message: 'Servicio asignado al paciente exitosamente.', id: result.insertId });
  })
);

// Actualizar un servicio relacionado con un paciente
router.put(
  '/patient/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { service_date, notes } = req.body;

    const [result] = await db.query(
      'UPDATE patient_services SET service_date = ?, notes = ?, updated_at = NOW() WHERE id = ?',
      [service_date, notes, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Servicio relacionado no encontrado.' });
    }

    res.json({ message: 'Servicio relacionado actualizado exitosamente.' });
  })
);

// Eliminar un servicio relacionado con un paciente
router.delete('/tratamientos/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
  
    try {
      const [result] = await db.query('DELETE FROM patient_services WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Tratamiento no encontrado.' });
      }
  
      res.json({ message: 'Tratamiento eliminado exitosamente.' });
    } catch (err) {
      console.error('Error en el servidor:', err);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  }));
  
module.exports = router;
