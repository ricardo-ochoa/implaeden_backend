// routes/email.js
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
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
      text: 'Recibo de pago adjunto.',
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

module.exports = router;
