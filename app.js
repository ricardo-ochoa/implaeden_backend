// app.js
const express   = require('express');
const cors      = require('cors');
const passport  = require('passport');
const path      = require('path');
const cookieParser = require('cookie-parser');

// 1) Carga dinámicamente .env.development o .env.production
const env = process.env.NODE_ENV || 'development';
require('dotenv').config({
  path: path.resolve(process.cwd(), `.env.${env}`)
});

// 2) Importar routers y middlewarea
const authRoutes               = require('./routes/auth');
const treatmentEvidencesRoutes = require('./routes/treatmentEvidences');
const pacienteRoutes           = require('./routes/pacientes');
const clinicalHistoryRoutes    = require('./routes/clinicalHistories');
const servicioRoutes           = require('./routes/servicios');
const paymentsRoutes           = require('./routes/payments');
const emailRoutes              = require('./routes/email');
const citasRoutes              = require('./routes/citas');
const uploadRoutes             = require('./routes/uploads');
const testRoutes               = require('./routes/test');
const { authenticateJwt }      = require('./middleware/auth');
const tratamientosRoutes = require('./routes/tratamientos');

// 3) Iniciar Express
const app = express();
app.set('trust proxy', 1);

// 4) Middlewares genéricos
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// 5) Configuración CORS desde env
const staticOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// Segundo, definimos el patrón dinámico para todas las URLs de Vercel
const vercelPattern = /^https:\/\/implaeden(-[a-z0-9-]+)?\.vercel\.app$/;

const corsOptions = {
  origin: (origin, callback) => {
    // Permitimos peticiones sin 'origin' (ej. Postman, apps móviles, etc.)
    // ¡Importante para pruebas locales!
    if (!origin) return callback(null, true);

    // Verificamos si el origen está en nuestra lista blanca estática O si coincide con el patrón de Vercel
    if (staticOrigins.includes(origin) || vercelPattern.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por la política de CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 6) Passport JWT
require('./auth/passport');
app.use(passport.initialize());

// 7) Logging básico de cada request
app.use((req, res, next) => {
  console.log(`→ [${env}] ${req.method} ${req.originalUrl}`);
  next();
});

// 8) Rutas públicas
app.use('/api/auth',    authRoutes);
app.use('/api/test',    testRoutes);
app.use('/api/uploads', uploadRoutes);

// 9) Rutas anidadas protegidas por JWT
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
  '/api/pacientes/:patientId/tratamientos/:treatmentId/evidencias',
  authenticateJwt,
  treatmentEvidencesRoutes
);

app.use('/api/pacientes/:patientId/tratamientos', authenticateJwt, tratamientosRoutes);

// 10) CRUD principal y otros recursos protegidos
app.use('/api/pacientes',          authenticateJwt, pacienteRoutes);
app.use('/api/clinical-histories', authenticateJwt, clinicalHistoryRoutes);
app.use('/api/servicios',          authenticateJwt, servicioRoutes);
app.use('/api/email',              authenticateJwt, emailRoutes);

// 11) Manejador de errores global
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error:   'Ocurrió un error en el servidor',
    details: err.message,
  });
});

// 12) Arranque del servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en ${env} en puerto ${PORT}`);
});
