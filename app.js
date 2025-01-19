const express = require('express');
const cors = require('cors');
const pacienteRoutes = require('./routes/pacientes');
const clinicalHistoryRoutes = require('./routes/clinicalHistories');
const testRoutes = require('./routes/test');
const uploadRoutes = require('./routes/uploads');
require('dotenv').config();

const app = express();

// Middleware para analizar JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Manejar datos en formato URL-encoded


// Configuración de CORS
app.use(
    cors({
      origin: ['http://localhost:3000', 'https://implaeden.vercel.app'], // Orígenes permitidos
      methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos permitidos
      allowedHeaders: ['Content-Type', 'Authorization'], // Headers permitidos
    })
  );
  
const corsOptions = {
    origin: [
      'http://localhost:3000', // Origen del frontend en desarrollo
      'https://implaeden.vercel.app', // Origen del frontend en producción
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Métodos permitidos
    allowedHeaders: ['Content-Type', 'Authorization'], // Headers permitidos
    credentials: true, // Permitir cookies/sesiones si las usas
  };

// Responde a las solicitudes OPTIONS para todas las rutas
app.options('*', cors());
app.options('*', cors(corsOptions));

// Middleware de depuración (opcional)
app.use((req, res, next) => {
  console.log(`Solicitud recibida: ${req.method} ${req.path}`);
  next();
});

// Rutas
app.use('/api/pacientes', pacienteRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/clinical-histories', clinicalHistoryRoutes);
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
