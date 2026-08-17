-- 012_services_category_legacy.sql
-- Arregla: POST /api/servicios fallaba con
--   "Field 'category' doesn't have a default value"
--
-- `services.category` es la columna vieja, de cuando la categoría era texto
-- suelto. Hoy la categoría vive en `service_categories` y se referencia con
-- `services.category_id`: el GET hace JOIN por ahí y NADA en el backend vuelve
-- a leer `services.category`.
--
-- Pero la columna quedó como NOT NULL sin default, así que cualquier alta de
-- servicio reventaba (en prod y también en dev; solo que se topó primero en
-- prod). Se relaja a NULL en vez de borrarla: los renglones viejos conservan su
-- valor y, si algún reporte externo todavía la lee, no se queda sin datos.
-- Eliminarla del todo es una decisión aparte, para cuando se confirme que nadie
-- la consulta.

ALTER TABLE `services` MODIFY `category` VARCHAR(255) NULL;
