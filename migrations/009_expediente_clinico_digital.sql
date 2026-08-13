-- 009_expediente_clinico_digital.sql
-- Expediente clínico odontológico capturado DENTRO de la app (formato físico
-- FO-CD-00003). Convive con `clinical_histories`, que sigue guardando los
-- archivos escaneados (imágenes/PDF): una fila por archivo.
--
-- Decisiones:
--   - Tabla nueva en vez de columnas extra en `clinical_histories`, para no
--     mezclar "archivo subido" con "formulario capturado" (el DELETE y el
--     upload de archivos siguen intactos).
--   - Varios expedientes por paciente, cada uno con su `record_date`
--     (revisiones periódicas). La sección de historial los lista mezclados
--     con los archivos, ordenados por fecha.
--   - `form_data` es JSON: el formulario tiene ~80 campos y sigue creciendo
--     (odontograma, aparatos y sistemas). Se guarda completo y la app lo
--     valida; en SQL solo se indexa lo que se necesita listar.

CREATE TABLE IF NOT EXISTS `clinical_records` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `patient_id` INT NOT NULL,
  `record_date` DATE NOT NULL,
  `status` ENUM('borrador','completado') NOT NULL DEFAULT 'borrador',
  `form_data` JSON NOT NULL,
  `created_by` INT DEFAULT NULL,
  `updated_by` INT DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_clinical_records_patient_date` (`patient_id`, `record_date`),
  CONSTRAINT `fk_clinical_records_patient`
    FOREIGN KEY (`patient_id`) REFERENCES `pacientes` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_clinical_records_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_clinical_records_updated_by`
    FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
