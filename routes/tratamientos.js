// routes/tratamientos.js
const express = require('express');
const db = require('../config/db');
const router = express.Router({ mergeParams: true });

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// GET /api/pacientes/:patientId/tratamientos
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const query = `
      SELECT 
        ps.id AS treatment_id, 
        ps.service_date, 
        ps.status,
        ps.total_cost     AS total_cost,   
        s.name AS service_name, 
        s.category AS service_category
      FROM patient_services ps
      INNER JOIN services s ON ps.service_id = s.id
      WHERE ps.patient_id = ?
      ORDER BY ps.service_date DESC
    `;
    const [rows] = await db.query(query, [patientId]);
    res.json(rows);
  })
);

router.delete(
  '/:treatmentId',
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params;

    // Lógica para borrar dependencias como pagos (si aplica)
    // await db.query('DELETE FROM patient_payments WHERE treatment_id = ?', [treatmentId]);

    const [result] = await db.query(
      'DELETE FROM patient_services WHERE id = ?',
      [treatmentId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Tratamiento no encontrado en la base de datos.' });
    }

    res.status(200).json({ message: 'Tratamiento eliminado exitosamente.' });
  })
);

module.exports = router;
