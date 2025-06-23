// routes/treatmentEvidences.js
const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
const multer = require('multer');
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const pool = require('../config/db');

// 1) Configura AWS
AWS.config.update({
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region:          process.env.AWS_REGION,
});
const s3 = new AWS.S3();

// 2) Multer (in memory)
const upload = multer({ storage: multer.memoryStorage() });

// 3) Helper para subir a S3
async function uploadFileToS3(file) {
  const key = `evidencias/${Date.now()}_${file.originalname}`;
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key:    key,
    Body:   file.buffer,
    ContentType: file.mimetype,
  };
  const { Location } = await s3.upload(params).promise();
  return Location;
}

// 4) GET: listar evidencias de un “patient_service”
router.get(
  '/:patientId/tratamientos/:treatmentId/evidencias',
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params;
    const [rows] = await pool.query(
      `SELECT id, patient_service_id, record_date, file_url, created_at
         FROM treatment_evidences
        WHERE patient_service_id = ?
        ORDER BY record_date DESC`,
      [treatmentId]
    );
    res.json(rows);
  })
);

// 5) POST: subir nuevas evidencias
router.post(
  '/:patientId/tratamientos/:treatmentId/evidencias',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const { treatmentId } = req.params;
    const { record_date } = req.body;

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Debes enviar al menos un archivo.' });
    }

    const urls = await Promise.all(req.files.map(uploadFileToS3));

    for (const url of urls) {
      await pool.query(
        `INSERT INTO treatment_evidences
           (patient_service_id, record_date, file_url, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [treatmentId, record_date || new Date(), url]
      );
    }

    res.status(201).json({ message: 'Evidencias subidas correctamente.', urls });
  })
);

// 6) DELETE: eliminar una evidencia
router.delete(
  '/:patientId/tratamientos/:treatmentId/evidencias/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [result] = await pool.query(
      `DELETE FROM treatment_evidences WHERE id = ?`,
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Evidencia no encontrada.' });
    }
    res.json({ message: 'Evidencia eliminada.' });
  })
);

module.exports = router;
