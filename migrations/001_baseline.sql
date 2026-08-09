-- 001_baseline.sql
-- Estado base del esquema = el que cargan los dumps iniciales (docker-entrypoint-initdb.d):
--   dev: dev-implaeden.sql · prod: implaeden-db.sql
-- Ambas BD ya tienen las tablas base, así que esta migración es solo un marcador
-- de línea base (no crea nada). Las tablas se crean/modifican desde 002 en adelante.
SELECT 1;
