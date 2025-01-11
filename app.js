const express = require('express');
const bodyParser = require('body-parser');
const pacienteRoutes = require('./routes/pacientes');
require('dotenv').config();

const app = express();

// Middleware
app.use(bodyParser.json());

// Rutas
app.use('/api/pacientes', pacienteRoutes);

// Inicio del servidor
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});


const testRoutes = require('./routes/test');
app.use('/api/test', testRoutes);
