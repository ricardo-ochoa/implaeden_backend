-- 006_pagos_baseline.sql
-- Formaliza el esquema de PAGOS en migraciones (antes solo vivía en los dumps de
-- sources_aws/dbs). En dev/prod es NO-OP: las tablas ya existen (CREATE TABLE IF
-- NOT EXISTS) y los catálogos se siembran con INSERT IGNORE (idempotente por
-- UNIQUE(name)). Aporta paridad para entornos nuevos y agrega el método
-- 'tarjeta_debito' que el frontend ya ofrecía pero no existía en la tabla.

CREATE TABLE IF NOT EXISTS `payment_methods` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `payment_statuses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `patient_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `patient_id` int NOT NULL,
  `fecha` date NOT NULL,
  `tratamiento` varchar(255) NOT NULL DEFAULT '',           -- legacy (texto libre); ya no se escribe
  `patient_service_id` int DEFAULT NULL COMMENT 'FK a patient_services(id)',
  `monto` decimal(10,2) NOT NULL,
  `numero_factura` varchar(100) DEFAULT NULL,
  `payment_method_id` int DEFAULT NULL,
  `payment_status_id` int NOT NULL DEFAULT '1',
  `notas` text,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `patient_id` (`patient_id`),
  KEY `fk_patient_payments_method` (`payment_method_id`),
  KEY `fk_patient_payments_status` (`payment_status_id`),
  KEY `fk_payments_service` (`patient_service_id`),
  CONSTRAINT `fk_patient_payments_method` FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods` (`id`),
  CONSTRAINT `fk_patient_payments_status` FOREIGN KEY (`payment_status_id`) REFERENCES `payment_statuses` (`id`),
  CONSTRAINT `fk_payments_service` FOREIGN KEY (`patient_service_id`) REFERENCES `patient_services` (`id`) ON DELETE CASCADE,
  CONSTRAINT `patient_payments_ibfk_1` FOREIGN KEY (`patient_id`) REFERENCES `pacientes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Catálogos base (idempotente). Agrega 'tarjeta_debito' donde falte.
INSERT IGNORE INTO `payment_methods` (`name`) VALUES
  ('Efectivo'), ('transferencia'), ('tarjeta_credito'), ('tarjeta_debito');

INSERT IGNORE INTO `payment_statuses` (`name`) VALUES
  ('abono'), ('finalizado'), ('cancelado'), ('reembolsado');
