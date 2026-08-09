-- 003_patient_phones.sql
-- Teléfonos de pacientes en relación muchos-a-muchos:
--   - un paciente puede tener varios teléfonos (cambió/agregó número)
--   - un teléfono puede pertenecer a varios pacientes (p. ej. el del padre/madre
--     usado para agendar al hijo → perfiles distintos que comparten teléfono)
-- `phone` se guarda NORMALIZADO: solo dígitos, últimos 10 (formato local MX),
-- que es como haremos el match contra el teléfono que extraemos de Confirmafy.

CREATE TABLE IF NOT EXISTS `patient_phones` (
  `id` int NOT NULL AUTO_INCREMENT,
  `patient_id` int NOT NULL,
  `phone` varchar(20) NOT NULL,
  `label` varchar(60) DEFAULT NULL,
  `is_primary` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_patient_phone` (`patient_id`, `phone`),
  KEY `idx_phone` (`phone`),
  CONSTRAINT `fk_pp_patient` FOREIGN KEY (`patient_id`)
    REFERENCES `pacientes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Backfill desde pacientes.telefono (normalizado a últimos 10 dígitos).
-- INSERT IGNORE + UNIQUE => idempotente (no duplica si se corre de nuevo).
INSERT IGNORE INTO `patient_phones` (`patient_id`, `phone`, `is_primary`)
SELECT `id`,
       RIGHT(REGEXP_REPLACE(`telefono`, '[^0-9]', ''), 10) AS phone,
       1
FROM `pacientes`
WHERE `telefono` IS NOT NULL
  AND CHAR_LENGTH(REGEXP_REPLACE(`telefono`, '[^0-9]', '')) >= 10;
