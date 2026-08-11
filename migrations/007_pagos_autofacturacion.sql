-- 007_pagos_autofacturacion.sql
-- Columnas para rastrear la orden cargada en el módulo de autofacturación de
-- factura.com. El FOLIO de la orden = patient_payments.id (numérico y único).
--   autofac_soft_id   -> soft_id que devuelve factura.com al crear la orden
--   autofac_status    -> loaded | invoiced | error
--   autofac_uuid      -> UUID del CFDI una vez que el paciente timbra
--   autofac_synced_at -> última sincronización con factura.com

ALTER TABLE `patient_payments`
  ADD COLUMN `autofac_soft_id`   varchar(64) DEFAULT NULL,
  ADD COLUMN `autofac_status`    varchar(20) DEFAULT NULL,
  ADD COLUMN `autofac_uuid`      varchar(64) DEFAULT NULL,
  ADD COLUMN `autofac_synced_at` timestamp   NULL DEFAULT NULL;
