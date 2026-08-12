-- 008_pagos_preservar_al_borrar_tratamiento.sql
-- Al borrar un tratamiento NO se deben perder sus pagos (registro histórico:
-- un tratamiento puede borrarse por error). Se cambia el FK de
-- patient_payments.patient_service_id de ON DELETE CASCADE a ON DELETE SET NULL:
-- el pago se conserva y su patient_service_id queda en NULL.
--
-- Complemento (en routes/tratamientos.js): antes de borrar el tratamiento, la
-- app copia el nombre del servicio a patient_payments.tratamiento (columna
-- legacy) para que el pago siga mostrando de qué era. El GET de pagos usa
-- COALESCE(services.name, patient_payments.tratamiento).

ALTER TABLE `patient_payments` DROP FOREIGN KEY `fk_payments_service`;

ALTER TABLE `patient_payments`
  ADD CONSTRAINT `fk_payments_service`
  FOREIGN KEY (`patient_service_id`) REFERENCES `patient_services` (`id`)
  ON DELETE SET NULL;
