// scripts/migrate.js
// ---------------------------------------------------------------------------
// Runner de migraciones SQL, forward-only, sin dependencias nuevas (mysql2).
//
// - Lee los .sql de ./migrations en orden alfabético (001_, 002_, ...).
// - Registra los aplicados en la tabla `schema_migrations` y solo corre los
//   pendientes (idempotente: re-ejecutar no repite lo ya aplicado).
//
// Conexión: toma DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME del entorno.
//   - En el contenedor de prod ya vienen inyectadas (docker-compose).
//   - En el host, si no están, carga .env.<NODE_ENV> (por defecto development).
//
// Uso:
//   npm run migrate:dev                      # dev (carga .env.development)
//   (en el contenedor prod)  npm run migrate # usa el env del contenedor
//   DB_HOST=.. DB_PORT=3308 DB_USER=.. DB_PASSWORD=.. DB_NAME=.. npm run migrate
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

if (!process.env.DB_HOST) {
  const env = process.env.NODE_ENV || 'development';
  require('dotenv').config({ path: path.resolve(__dirname, '..', `.env.${env}`) });
}

const cfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  multipleStatements: true,
};

const DIR = path.resolve(__dirname, '..', 'migrations');

(async () => {
  const conn = await mysql.createConnection(cfg);
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   VARCHAR(255) NOT NULL PRIMARY KEY,
       applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const [rows] = await conn.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  console.log(`Objetivo: ${cfg.host}:${cfg.port}/${cfg.database}`);
  console.log(`Migraciones: ${files.length} en disco, ${applied.size} ya aplicadas`);

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    process.stdout.write(`  → ${f} ... `);
    try {
      // Nota: en MySQL el DDL hace commit implícito; por eso las migraciones
      // deben ser idempotentes (CREATE TABLE IF NOT EXISTS, etc.).
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [f]);
      console.log('OK');
      ran++;
    } catch (e) {
      console.log('FALLÓ');
      console.error(`    ${e.sqlMessage || e.message}`);
      await conn.end();
      process.exit(1);
    }
  }

  console.log(ran ? `Hecho: ${ran} migración(es) nueva(s).` : 'Nada pendiente, esquema al día.');
  await conn.end();
})().catch((e) => {
  console.error('ERROR:', e.code || e.message);
  process.exit(1);
});
