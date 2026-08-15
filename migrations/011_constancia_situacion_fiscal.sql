-- 011_constancia_situacion_fiscal.sql
-- Constancia de Situación Fiscal (CSF) por paciente, para poder facturarle.
--
-- Tres piezas:
--   1. patient_fiscal_profiles  datos que se transcriben de la constancia
--      (RFC, razón social, régimen, C.P.). Opcionales: sirven para facturar sin
--      volver a abrir el PDF. Tabla aparte y no columnas en `pacientes` porque
--      es información administrativa, no clínica, y `pacientes` se lee en toda
--      la app con SELECT *.
--   2. patient_fiscal_documents historial de archivos. El SAT reexpide la
--      constancia (cambia domicilio, régimen, etc.), así que se conservan todas
--      las versiones y solo una queda marcada como `vigente`.
--   3. patient_fiscal_tokens    link privado para que el propio paciente suba
--      su constancia cuando la clínica no la tiene.

CREATE TABLE IF NOT EXISTS `patient_fiscal_profiles` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `patient_id` INT NOT NULL,
  `rfc` VARCHAR(13) DEFAULT NULL,
  `razon_social` VARCHAR(255) DEFAULT NULL,
  `regimen_fiscal` VARCHAR(120) DEFAULT NULL,
  `codigo_postal` VARCHAR(10) DEFAULT NULL,
  `updated_by` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- Un solo perfil fiscal por paciente.
  UNIQUE KEY `uq_fiscal_profile_patient` (`patient_id`),
  KEY `idx_fiscal_profile_rfc` (`rfc`),
  CONSTRAINT `fk_fiscal_profile_patient`
    FOREIGN KEY (`patient_id`) REFERENCES `pacientes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_fiscal_profile_user`
    FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `patient_fiscal_documents` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `patient_id` INT NOT NULL,
  `file_url` VARCHAR(500) NOT NULL,
  `file_key` VARCHAR(500) NOT NULL,
  `file_name` VARCHAR(255) DEFAULT NULL,
  `mime_type` VARCHAR(120) DEFAULT NULL,
  `size_bytes` INT DEFAULT NULL,
  -- Solo un documento vigente por paciente; el resto es historial.
  `vigente` TINYINT(1) NOT NULL DEFAULT 1,
  -- De dónde salió: capturado en la clínica, subido por el paciente con su
  -- link privado, o migrado del export de Notion.
  `origen` ENUM('clinica','paciente','import') NOT NULL DEFAULT 'clinica',
  `uploaded_by` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fiscal_doc_patient` (`patient_id`, `vigente`),
  -- Evita duplicar el mismo objeto si el import se corre dos veces.
  UNIQUE KEY `uq_fiscal_doc_key` (`file_key`),
  CONSTRAINT `fk_fiscal_doc_patient`
    FOREIGN KEY (`patient_id`) REFERENCES `pacientes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_fiscal_doc_user`
    FOREIGN KEY (`uploaded_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `patient_fiscal_tokens` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `patient_id` INT NOT NULL,
  -- Aleatorio de 32 bytes en hex. Se guarda en claro a propósito: el link se
  -- comparte por WhatsApp y hay que poder volver a copiarlo sin invalidar el
  -- que ya se envió. El alcance de un token filtrado se limita a subir un
  -- documento a ese paciente, y se acota con caducidad + revocación.
  `token` VARCHAR(64) NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `revoked_at` DATETIME DEFAULT NULL,
  `used_count` INT NOT NULL DEFAULT 0,
  `last_used_at` DATETIME DEFAULT NULL,
  `created_by` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fiscal_token` (`token`),
  KEY `idx_fiscal_token_patient` (`patient_id`),
  CONSTRAINT `fk_fiscal_token_patient`
    FOREIGN KEY (`patient_id`) REFERENCES `pacientes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_fiscal_token_user`
    FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
