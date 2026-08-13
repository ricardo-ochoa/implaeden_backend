-- 010_doctores.sql
-- Catálogo de médicos/odontólogos de la clínica, para poder firmar el
-- expediente clínico seleccionando de una lista en vez de escribir el nombre.
--
-- Tabla aparte de `users`: `users.role='medico'` es acceso a la app, mientras
-- que aquí interesa quién trata y firma (con cédula profesional), que no
-- necesariamente tiene cuenta. `user_id` queda por si más adelante se quiere
-- ligar un médico con su usuario.
--
-- `activo` en lugar de borrado: un médico que deja la clínica no debe
-- desaparecer de los expedientes que ya firmó.

CREATE TABLE IF NOT EXISTS `doctors` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `nombre` VARCHAR(150) NOT NULL,
  `titulo` VARCHAR(100) DEFAULT NULL,
  `cedula_profesional` VARCHAR(50) NOT NULL,
  `activo` TINYINT(1) NOT NULL DEFAULT 1,
  `user_id` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_doctors_cedula` (`cedula_profesional`),
  KEY `idx_doctors_activo` (`activo`),
  CONSTRAINT `fk_doctors_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Médico actual de la clínica. Idempotente: la cédula es única, así que
-- re-aplicar la migración no duplica el renglón.
INSERT INTO `doctors` (`nombre`, `titulo`, `cedula_profesional`, `activo`)
VALUES ('DRA. CONSUELO OCHOA SALAYA', 'CIRUJANO DENTISTA', '1306579', 1)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`),
  `titulo` = VALUES(`titulo`);
