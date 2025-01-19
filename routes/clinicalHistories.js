const express = require('express');
const router = express.Router();
const db = require('../config/db');
const AWS = require('aws-sdk');
const multer = require('multer');

// Middleware para manejar errores
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Configuración de AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-2',
});

const s3 = new AWS.S3();

// Configuración de Multer para manejar archivos
const upload = multer({ storage: multer.memoryStorage() });

// Función para subir archivos a S3
const uploadFileToS3 = async (file) => {
  const fileName = `clinical_histories/${Date.now()}_${file.originalname}`;
  const params = {
    Bucket: 'implaeden',
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: 'public-read',
  };

  try {
    const uploadResult = await s3.upload(params).promise();
    const fileUrl = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
    console.log('Archivo subido a S3:', fileUrl);
    return fileUrl;
  } catch (error) {
    console.error('Error al subir a S3:', error);
    throw new Error('Error al subir el archivo a S3.');
  }
};

// Obtener todos los historiales clínicos de un paciente
router.get(
  '/:patientId',
  asyncHandler(async (req, res) => {
    const { patientId } = req.params;
    const [rows] = await db.query('SELECT * FROM clinical_histories WHERE patient_id = ?', [patientId]);
    res.json(rows);
  })
);

// Crear un nuevo historial clínico
router.post(
    '/:patientId',
    upload.array('files', 10),
    asyncHandler(async (req, res) => {
      console.log('Body:', req.body); // Depuración
      console.log('Files:', req.files); // Depuración
  
      const { patientId } = req.params;
      const { record_date } = req.body;
  
      if (!record_date || !req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'La fecha de registro y al menos un archivo son obligatorios.' });
      }
  
      const fileUrls = await Promise.all(req.files.map(uploadFileToS3));
  
      await Promise.all(
        fileUrls.map((url) =>
          db.query(
            'INSERT INTO clinical_histories (patient_id, record_date, file_url, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
            [patientId, record_date, url]
          )
        )
      );
  
      res.status(201).json({ message: 'Historial clínico creado exitosamente.' });
    })
  );  
  
// Actualizar un historial clínico
router.put(
  '/:id',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { record_date } = req.body;

    let fileUrl = null;
    if (req.file) {
      fileUrl = await uploadFileToS3(req.file);
    }

    const [result] = await db.query(
      'UPDATE clinical_histories SET record_date = ?, file_url = ?, updated_at = NOW() WHERE id = ?',
      [record_date, fileUrl, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Historial clínico no encontrado.' });
    }

    res.json({ message: 'Historial clínico actualizado exitosamente.' });
  })
);

// Eliminar un historial clínico
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM clinical_histories WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Historial clínico no encontrado.' });
    }
    res.json({ message: 'Historial clínico eliminado exitosamente.' });
  })
);

module.exports = router;
