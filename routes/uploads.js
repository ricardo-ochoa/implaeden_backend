const express = require('express');
const AWS = require('aws-sdk');
const multer = require('multer');
const router = express.Router();

// Configurar AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-2', // Cambia a la región de tu bucket
});

const s3 = new AWS.S3();

// Configurar Multer para manejar la carga de archivos
const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload', upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se proporcionó una foto.' });
    }

    // Configurar parámetros de carga
    const params = {
      Bucket: 'implaeden', // Reemplaza con el nombre de tu bucket
      Key: `profile_photos/${Date.now()}_${req.file.originalname}`, // Ruta del archivo en S3
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read', // Permitir acceso público
    };

    // Subir a S3
    const uploadResult = await s3.upload(params).promise();
    res.status(200).json({ url: uploadResult.Location });
  } catch (error) {
    console.error('Error al subir la foto:', error);
    res.status(500).json({ error: 'Error al subir la foto a S3.' });
  }
});

module.exports = router;
