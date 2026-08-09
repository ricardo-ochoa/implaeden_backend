-- 002_patient_treatment_comments.sql
-- Feature "comentarios de tratamiento". Ya existe en dev; con IF NOT EXISTS
-- esta migración es no-op en dev y crea las tablas en prod (igualando ambas).
-- Orden: primero la tabla padre (comments), luego la hija (comment_media, FK).

CREATE TABLE IF NOT EXISTS `patient_treatment_comments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `patient_id` int NOT NULL,
  `patient_service_group_id` int DEFAULT NULL,
  `patient_service_id` int NOT NULL,
  `comment_html` mediumtext,
  `teeth_ids` json DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ptc_patient` (`patient_id`),
  KEY `idx_ptc_group` (`patient_service_group_id`),
  KEY `idx_ptc_treatment` (`patient_service_id`),
  CONSTRAINT `fk_ptc_treatment` FOREIGN KEY (`patient_service_id`)
    REFERENCES `patient_services` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `patient_treatment_comment_media` (
  `id` int NOT NULL AUTO_INCREMENT,
  `comment_id` int NOT NULL,
  `file_url` text NOT NULL,
  `mime_type` varchar(120) DEFAULT NULL,
  `original_name` varchar(255) DEFAULT NULL,
  `size_bytes` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ptcm_comment` (`comment_id`),
  CONSTRAINT `fk_ptcm_comment` FOREIGN KEY (`comment_id`)
    REFERENCES `patient_treatment_comments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
