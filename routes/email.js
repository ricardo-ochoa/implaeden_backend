// routes/email.js
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const router = express.Router();
const upload = multer();


// Ruta: POST /api/email/enviar-factura
router.post('/enviar-factura', upload.single('pdf'), async (req, res) => {
  const { to } = req.body;
  const pdfBuffer = req.file?.buffer;

  if (!to || !pdfBuffer) {
    return res.status(400).json({ error: 'Faltan datos: destinatario o PDF' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Clínica Dental Implaeden" <${process.env.EMAIL_USER}>`,
      to,
      subject: '[Recibo de Pago] - Clínica Implaeden',
      text: 'Recibo de pago adjunto.\n\nSaludos, Implaedén®.\n\n',
      attachments: [
        {
          filename: 'recibo_de_pago.pdf',
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    res.status(200).json({ message: 'Correo enviado correctamente.' });
  } catch (error) {
    console.error('Error al enviar el correo:', error);
    res.status(500).json({ error: 'Error al enviar el correo.' });
  }
});

router.post('/enviar-documentos', async (req, res) => {
  const { to, documentUrls, subject, body: textBody } = req.body;

  if (!to || !Array.isArray(documentUrls) || documentUrls.length === 0) {
    return res.status(400).json({ error: 'Faltan datos: destinatario o lista de URLs' });
  }

  try {
    // Descargar cada documento y crear attachments
    const attachments = await Promise.all(documentUrls.map(async (url) => {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      // Extraer nombre de archivo de la URL
      const filename = path.basename(new URL(url).pathname);
      return {
        filename,
        content: Buffer.from(response.data, 'binary'),
        contentType: response.headers['content-type'] || 'application/octet-stream',
      };
    }));

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Clínica Dental Implaeden" <${process.env.EMAIL_USER}>`,
      to,
      subject: subject || '[Documentos Clínica Implaeden]',
      text: textBody || 'Adjunto encontrarás tus documentos.',
      attachments,
    });

    res.status(200).json({ message: 'Correo con documentos enviado correctamente.' });
  } catch (error) {
    console.error('Error al enviar documentos por correo:', error);
    res.status(500).json({ error: 'Error al enviar documentos por correo.' });
  }
});

module.exports = router;
