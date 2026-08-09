-- 004_pacientes_registro_rapido.sql
-- Permite crear un paciente "rápido" (solo nombre + teléfono) cuando alguien
-- agenda por Confirmafy y no existe en la BD. Los demás datos se completan después.
-- Relajamos NOT NULL en apellidos / fecha_nacimiento / email y agregamos un flag.

ALTER TABLE `pacientes` MODIFY `apellidos` varchar(150) NULL;
ALTER TABLE `pacientes` MODIFY `fecha_nacimiento` date NULL;
ALTER TABLE `pacientes` MODIFY `email` varchar(150) NULL;

-- Flag para recordar que el registro está incompleto (MySQL no soporta
-- ADD COLUMN IF NOT EXISTS; esta migración corre una sola vez).
ALTER TABLE `pacientes` ADD COLUMN `registro_incompleto` tinyint(1) NOT NULL DEFAULT 0;
