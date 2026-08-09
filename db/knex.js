// db/knex.js
// ---------------------------------------------------------------------------
// Instancia única de Knex (query builder) para el backend.
// Convive con el `config/db.js` (mysql2 crudo) existente: lo NUEVO usa Knex,
// lo viejo sigue igual hasta migrarlo gradualmente.
// Lee las MISMAS variables de entorno que config/db.js (DB_HOST, etc.).
// ---------------------------------------------------------------------------
const knex = require('knex');

const instance = knex({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: 'Z',
  },
  pool: { min: 0, max: 10 },
});

module.exports = instance;
