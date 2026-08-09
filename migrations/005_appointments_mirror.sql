-- 005_appointments_mirror.sql
-- Espejo de solo-lectura de las citas de Google Calendar (GCal sigue siendo la
-- FUENTE DE VERDAD; aquí solo replicamos para consultas rápidas, joins,
-- reportes y, a futuro, RAG). Se llena/actualiza con un sync incremental
-- (services/appointmentsSync.js) usando el `syncToken` de Google.
--
-- Fechas: guardamos `start_at`/`end_at` en UTC (DATETIME) para comparar e
-- indexar (p. ej. "próxima" vs "anterior" contra UTC_TIMESTAMP()), y además
-- `start_iso`/`end_iso` con el string original (con offset) para mostrar.

CREATE TABLE IF NOT EXISTS `appointments` (
  `event_id`      varchar(191) NOT NULL,           -- id del evento en Google (clave)
  `patient_id`    int DEFAULT NULL,                -- extendedProperties.clinicPatientId
  `service_id`    int DEFAULT NULL,
  `treatment`     varchar(512) DEFAULT NULL,       -- serviceName o título del evento
  `observations`  text,
  `status`        varchar(32) DEFAULT NULL,        -- scheduled|confirmed|completed|cancelled|no_show
  `source`        varchar(32) DEFAULT NULL,        -- clinic-app|confirmafy|manual
  `contact_name`  varchar(255) DEFAULT NULL,
  `contact_phone` varchar(32)  DEFAULT NULL,
  `emoji`         varchar(32)  DEFAULT NULL,        -- pista visual de Confirmafy (🟢/🟡/🔴)
  `is_linked`     tinyint(1) NOT NULL DEFAULT 0,    -- ¿vinculada a un paciente?
  `start_at`      datetime DEFAULT NULL,            -- inicio en UTC
  `end_at`        datetime DEFAULT NULL,            -- fin en UTC
  `start_iso`     varchar(64) DEFAULT NULL,         -- inicio original (RFC3339 con offset)
  `end_iso`       varchar(64) DEFAULT NULL,
  `etag`          varchar(128) DEFAULT NULL,
  `raw`           json DEFAULT NULL,                -- evento completo de Google (respaldo)
  `synced_at`     timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`event_id`),
  KEY `idx_patient_start` (`patient_id`, `start_at`),
  KEY `idx_start` (`start_at`),
  KEY `idx_phone` (`contact_phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Estado del sync incremental (una sola fila, id=1): guardamos el syncToken de
-- Google y la última corrida. Si el token expira (410), se hace resync completo.
CREATE TABLE IF NOT EXISTS `gcal_sync_state` (
  `id`             tinyint NOT NULL,
  `sync_token`     text,
  `last_synced_at` timestamp NULL DEFAULT NULL,
  `last_status`    varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
