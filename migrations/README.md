# Migraciones de base de datos

Migraciones SQL **forward-only**, versionadas en el repo. Un runner propio
(`scripts/migrate.js`, sin dependencias nuevas) aplica los `.sql` pendientes y
lleva control en la tabla `schema_migrations`.

## Reglas

- **Nunca** edites el esquema de prod a mano. Todo cambio de BD = una migración.
- Archivos numerados: `001_...`, `002_...`, `003_...` (orden alfabético = orden de aplicación).
- **Idempotentes**: usa `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN` con verificación, etc.
  (en MySQL el DDL hace commit implícito; no hay rollback automático).
- Forward-only: no hay `down`. Para revertir, escribe una migración nueva.

## Flujo dev → prod

1. Crea `migrations/00X_mi_cambio.sql`.
2. Aplica en **dev** y prueba el feature:
   ```bash
   cd implaeden_backend && npm run migrate:dev
   ```
3. Commit al repo.
4. **Backup de prod** (dump) antes de tocarlo.
5. Aplica en **prod**. Dos formas:
   - Desde el contenedor (recomendado): Portainer → `implaeden-backend-prod` → Console (`/bin/sh`) →
     ```bash
     npm run migrate
     ```
     (usa el env del contenedor: `mysql-prod`).
   - Desde el host, pasando las variables de prod:
     ```bash
     DB_HOST=192.168.100.10 DB_PORT=3308 DB_USER=implaeden DB_PASSWORD=*** DB_NAME=implaeden npm run migrate
     ```
6. Verifica.

## Estado

- `001_baseline.sql` — línea base (esquema de los dumps iniciales; marcador).
- `002_patient_treatment_comments.sql` — crea `patient_treatment_comments` y
  `patient_treatment_comment_media` (igualó prod con dev).

`schema_migrations` registra qué se aplicó en cada BD.
