// app.js
const express = require("express");
const cors = require("cors");
const passport = require("passport");
const path = require("path");
const cookieParser = require("cookie-parser");

const env = process.env.NODE_ENV || "development";
require("dotenv").config({
  path: path.resolve(__dirname, `.env.${env}`),
});

// Routers
const authRoutes = require("./routes/auth");
const treatmentEvidencesRoutes = require("./routes/treatmentEvidences");
const pacienteRoutes = require("./routes/pacientes");
const clinicalHistoryRoutes = require("./routes/clinicalHistories");
const servicioRoutes = require("./routes/servicios");
const paymentsRoutes = require("./routes/payments");
const emailRoutes = require("./routes/email");
const citasRoutes = require("./routes/citas");
const uploadRoutes = require("./routes/uploads");
const testRoutes = require("./routes/test");
const tratamientosRoutes = require("./routes/tratamientos");
const patientSummaryTtsRoutes = require("./routes/patientSummaryTts");
const aiRoutes = require("./routes/ai");
const patientTreatmentEventsRoutes = require("./routes/patientTreatmentEvents");

const { authenticateJwt } = require("./middleware/auth");

const app = express();
app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// cookie -> Authorization
app.use((req, _res, next) => {
  if (!req.headers.authorization && req.cookies?.token) {
    req.headers.authorization = `Bearer ${req.cookies.token}`;
  }
  next();
});

// CORS
const staticOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const vercelPattern = /^https:\/\/implaeden(-[a-z0-9-]+)?\.vercel\.app$/;

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (staticOrigins.includes(origin) || vercelPattern.test(origin)) return callback(null, true);
    return callback(new Error("No permitido por la política de CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Passport
require("./auth/passport");
app.use(passport.initialize());

// Logging
app.use((req, res, next) => {
  console.log(`→ [${env}] ${req.method} ${req.originalUrl}`);
  next();
});

// Public
app.use("/api/auth", authRoutes);
app.use("/api/test", testRoutes);
app.use("/api/uploads", uploadRoutes);

// Protected
app.use("/api/ai", authenticateJwt, aiRoutes);

// ✅ Protected nested (aquí va events)
app.use("/api/pacientes/:patientId/pagos", authenticateJwt, paymentsRoutes);
app.use("/api/pacientes/:patientId/citas", authenticateJwt, citasRoutes);
app.use(
  "/api/pacientes/:patientId/events",
  authenticateJwt,
  patientTreatmentEventsRoutes
);

app.use(
  "/api/pacientes/:patientId/tratamientos/:treatmentId/evidencias",
  authenticateJwt,
  treatmentEvidencesRoutes
);
app.use("/api/pacientes/:patientId/tratamientos", authenticateJwt, tratamientosRoutes);
app.use("/api/pacientes/:patientId", authenticateJwt, patientSummaryTtsRoutes);

// Protected main
app.use("/api/pacientes", authenticateJwt, pacienteRoutes);
app.use("/api/clinical-histories", authenticateJwt, clinicalHistoryRoutes);
app.use("/api/servicios", authenticateJwt, servicioRoutes);
app.use("/api/email", authenticateJwt, emailRoutes);

// ✅ Error handler SIEMPRE al final
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: "Ocurrió un error en el servidor",
    details: err.message,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en ${env} en puerto ${PORT}`);
});
