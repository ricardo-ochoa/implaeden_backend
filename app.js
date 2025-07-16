// app.js
const express = require('express');
const cors = require('cors');
const passport = require('passport');
require('dotenv').config();

// Importar routers
const authRoutes = require('./routes/auth');
const treatmentEvidencesRoutes = require('./routes/treatmentEvidences');
const pacienteRoutes = require('./routes/pacientes');
const clinicalHistoryRoutes = require('./routes/clinicalHistories');
const servicioRoutes = require('./routes/servicios');
const paymentsRoutes = require('./routes/payments');
const emailRoutes = require('./routes/email');
const citasRoutes = require('./routes/citas');
const tratamientosRoutes = require('./routes/tratamientos');
const uploadRoutes = require('./routes/uploads');
const testRoutes = require('./routes/test');
const { authenticateJwt }      = require('./middleware/auth');

const app = express();

// Middlewares globales
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de CORS
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'https://implaeden.vercel.app',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Inicializar Passport
require('./auth/passport');
app.use(passport.initialize());

// Logging de solicitudes
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.originalUrl}`);
  next();
});

// Rutas públicas
app.use('/api/auth', authRoutes);
app.use('/api/test', testRoutes);
app.use('/api/uploads', uploadRoutes);

// Subrecursos de un paciente (montados antes que el CRUD genérico para evitar colisiones)
app.use(
  '/api/pacientes/:patientId/pagos',
  authenticateJwt,
  paymentsRoutes
);

app.use(
  '/api/pacientes/:patientId/citas',
  authenticateJwt,
  citasRoutes
);
app.use(
  '/api/pacientes/:patientId/tratamientos',
  authenticateJwt,
  tratamientosRoutes
);

app.use(
  '/api/pacientes/:patientId/tratamientos/:treatmentId/evidencias',
  authenticateJwt,
  treatmentEvidencesRoutes
);

// Pacientes (CRUD principal)
app.use(
  '/api/pacientes',
  authenticateJwt,
  pacienteRoutes
);

// Otros recursos globales
app.use(
  '/api/clinical-histories',
  authenticateJwt,
  clinicalHistoryRoutes
);
app.use(
  '/api/servicios',
  authenticateJwt,
  servicioRoutes
);
app.use(
  '/api/email',
  authenticateJwt,
  emailRoutes
);

// Manejo global de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Ocurrió un error en el servidor',
    details: err.message,
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
