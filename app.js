const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Importa el middleware CORS
const pacienteRoutes = require('./routes/pacientes');
const testRoutes = require('./routes/test');
require('dotenv').config();

const app = express();

// Middleware
app.use(bodyParser.json());

// Configuración de CORS
app.use(
  cors({
    origin: [
        'http://localhost:3000', // Para desarrollo local
        'https://implaeden.vercel.app', // Para producción en Vercel
      ],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
