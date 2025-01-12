const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pacienteRoutes = require('./routes/pacientes');
const testRoutes = require('./routes/test');
require('dotenv').config();

const app = express();

// Middleware para analizar JSON
app.use(bodyParser.json());

// Configuración de CORS
app.use(
  cors({
    origin: [
      'http://localhost:3000', // Permite solicitudes desde tu frontend local
      'https://implaeden.vercel.app', // Permite solicitudes desde Vercel en producción
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos HTTP permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Encabezados permitidos
  })
);

// Rutas
app.use('/api/pacientes', pacienteRoutes);
app.use('/api/test', testRoutes);

// Inicio del servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});

// Manejo global de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Ocurrió un error en el servidor',
    details: err.message,
  });
});
