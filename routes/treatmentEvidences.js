// routes/treatmentEvidences.js
const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
const multer = require('multer');
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const db = require('../config/db');

// --- 1) Configuración de AWS S3
AWS.config.update({
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region:          process.env.AWS_REGION,
});
const s3 = new AWS.S3();

// --- 2) Multer en memoria para buffers
const upload = multer({ storage: multer.memoryStorage() });

// --- 3) Helper: subir un archivo a S3 y devolver su URL pública
async function uploadFileToS3(file) {
  const key = `evidencias/${Date.now()}_${file.originalname}`;
  const params = {
    Bucket:       process.env.S3_BUCKET_NAME,
    Key:          key,
    Body:         file.buffer,
    ContentType:  file.mimetype,
  };
  const { Location } = await s3.upload(params).promise();
  return Location;
}

// --- 4) GET: listar evidencias de un tratamiento
router.get(
  '/pacientes/:patientId/tratamientos/:treatmentId/evidencias',
  asyncHandler(async (req, res) => {
    const { patientId, treatmentId } = req.params;

    // (Opcional) podrías validar que el tratamiento pertenezca al paciente aquí

    const rows = await db('treatment_evidences')
      .where({ treatment_id: treatmentId })
      .orderBy('record_date', 'desc');

    res.json(rows);
  })
);

// --- 5) POST: subir nuevas evidencias (fotos o vídeos)
router.post(
  '/pacientes/:patientId/tratamientos/:treatmentId/evidencias',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const { patientId, treatmentId } = req.params;
    const { record_date } = req.body;

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Debes enviar al menos un archivo.' });
    }

    // 1) Subir todos los archivos a S3
    const urls = await Promise.all(req.files.map(uploadFileToS3));

    // 2) Insertar cada URL en la tabla treatment_evidences
    await Promise.all(
      urls.map((url) =>
        db('treatment_evidences').insert({
          treatment_id: treatmentId,
          record_date:  record_date || db.fn.now(),
          file_url:     url,
          created_at:   db.fn.now(),
          updated_at:   db.fn.now(),
        })
      )
    );

    res
      .status(201)
      .json({ message: 'Evidencias subidas correctamente.', urls });
  })
);

module.exports = router;
