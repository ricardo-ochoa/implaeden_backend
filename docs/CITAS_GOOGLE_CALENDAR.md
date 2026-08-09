# Módulo de Citas ↔ Google Calendar — Estado de implementación

Basado en el spec `spec-citas-google-calendar.md`, adaptado al codebase real
(Express `routes/` en CommonJS + Next.js). **GCal = fuente de verdad.**

## Estado: Fase 1 implementada (leer + crear + UI) ✅ — falta configurar GCP

### Backend (`implaeden_backend`)
- `services/googleCalendar.js` — capa de servicio GCal. **Init lazy y tolerante**:
  si faltan credenciales, no se cae la app; los métodos lanzan `GCAL_NOT_CONFIGURED`
  y las rutas responden **503**. Mapeo evento↔cita con `serviceId`+`serviceName`
  en `extendedProperties.private` (mantiene el link al catálogo `services`).
- `db/knex.js` — **primer uso de Knex** (query builder), convive con `config/db.js`.
- `services/lookups.js` — `patientExists()` / `getService()` vía Knex (validaciones al crear).
- `routes/citas.js` — repuntado a GCal (montado en `/api/pacientes/:patientId/citas`):
  - `GET /` → citas del paciente (filtra por `clinicPatientId`).
  - `POST /` → crea evento en GCal (valida paciente/servicio con Knex).
- `routes/appointments.js` — vista global, montado en `/api/appointments` (auth JWT):
  - `GET /calendar?from=&to=` → todas las citas del rango.
- La tabla MySQL `citas` queda **legacy** (ya no se usa desde aquí).

### Frontend (`implaeden-frontend`)
- `components/citas/CitaModal.js` — crear cita (fecha/hora + **duración** → calcula `end`;
  envía hora "de pared", el backend aplica la zona de la clínica).
- `components/citas/CitasTable.js` — nueva forma (`start`, `treatment`, `status`, `source`)
  + badges de **Estado** y **Origen**. Sin editar/eliminar en Fase 1.
- `app/pacientes/[id]/citas/CitasClient.js` — listar (SWR) + crear.
- `app/agenda/page.js` + `components/citas/AgendaClient.js` — **vista global** de la clínica
  (navegación por mes; "Sin asignar" para citas de Confirmafy sin vincular).

## Límite con Confirmafy (importante)
NO se integra con Confirmafy: el **único** punto de contacto es Google Calendar.
Confirmafy escribe eventos en GCal; Implaedén lee/escribe en GCal. Los eventos de
Confirmafy llegan como `source: confirmafy` (sin vincular → "Sin asignar").

⚠️ Confirmafy→GCal es (probablemente) **unidireccional**: los cambios que Implaedén
haga en GCal **pueden no propagarse de vuelta a Confirmafy** (sus recordatorios de
WhatsApp). Para citas de origen Confirmafy, una cancelación desde la app quizá
requiera avisar al paciente por WhatsApp aparte. Verificar si Confirmafy tiene
sync bidireccional con GCal.

## Configuración requerida (GCP — hazlo una vez)

> ⚠️ En cuentas Gmail personales, Google aplica políticas gestionadas "seguras por
> defecto" (org automática) que **bloquean crear keys de Service Account**
> (`iam.disableServiceAccountKeyCreation`, heredada, no removible por el usuario).
> Por eso la vía recomendada es **OAuth2** (no usa key). Ventaja extra: al autorizar
> tu propia cuenta (dueña del calendario) **no hay que compartir el calendario**.

### Opción A — OAuth2 (recomendada)
1. Google Calendar API habilitada ✔.
2. **Pantalla de consentimiento OAuth**: tipo *External*; agrega tu cuenta como
   *usuario de prueba*; scope `.../auth/calendar` (aparece "app no verificada" →
   Avanzado → Continuar; OK para uso interno de una cuenta).
3. **Credenciales → Crear credenciales → ID de cliente OAuth → Aplicación web**;
   agrega redirect URI `http://localhost:5055/oauth2callback`. Copia Client ID/Secret.
4. En `.env.development`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `CLINIC_CALENDAR_ID` (o `primary`).
5. `node scripts/google-oauth.js` → abre la URL → autoriza → copia el
   `GOOGLE_OAUTH_REFRESH_TOKEN` impreso a `.env.development`.
6. Reinicia el backend. (Prod: mismas vars en el env del contenedor.)

### Opción B — Service Account (solo si tu proyecto permite keys)
1. Crear Service Account → **key JSON** → compartir el calendario con su email
   (permiso "Hacer cambios en los eventos").
2. `GOOGLE_SERVICE_ACCOUNT_KEY='{...}'` (una línea) + `CLINIC_CALENDAR_ID`.

El código soporta ambas: usa OAuth si hay refresh token; si no, la Service Account.

## Probar (una vez configurado)
- `GET /api/appointments/calendar?from=…&to=…` → 200 con array (antes: 503).
- Crear una cita desde la app → verificar que aparece en Google Calendar.
- Vista `/agenda` → citas del mes; las de Confirmafy salen "Sin asignar".

## Fase 2 — estado
**Implementado y verificado (dev):**
- Migraciones `003_patient_phones` (+backfill) y `004_pacientes_registro_rapido`.
- Extracción teléfono/nombre del evento; `listUnassigned`, `linkToPatient`, `update`, `remove`.
- `services/reconcile.js` (Knex): match por teléfono/nombre + `quickCreatePatient` + `addPhoneToPatient`.
- Endpoints: `GET /api/appointments/unassigned`, `POST /:eventId/link`, `PATCH /:eventId`,
  `DELETE /:eventId`, `POST /api/pacientes/quick`.
- Frontend: bandeja `/agenda/sin-asignar` (`ReconcileClient`) con acciones 1-click + "Elegir otro".

**Falta:**
- UI de **editar/eliminar** citas (endpoints `PATCH`/`DELETE` ya listos) — modal de edición en `/agenda`.
- Recordatorios propios (n8n) al reagendar/cancelar (ver más abajo).
- **Reconciliación Confirmafy↔paciente (diseño):** Confirmafy solo captura nombre+teléfono.
  El teléfono se extrae **limpio** del link `wa.me/send?phone=...` del evento; el nombre, del título.
  - **Modelo:** tabla nueva `patient_phones(id, patient_id, phone_e164, label, is_primary)`
    (muchos-a-muchos: un paciente varios teléfonos; un teléfono varios pacientes). Migración + backfill desde `pacientes.telefono`.
  - **Motor de match** por teléfono normalizado (últimos 10 dígitos MX):
    - 1 paciente → **auto-vincular** (escenario "mismo número").
    - 2+ pacientes → **desambiguar** (escenario "menor desde el tel. del padre/madre": padre e hijo son perfiles distintos que comparten teléfono).
    - 0 por teléfono pero **nombre** coincide → **sugerir** ese paciente; al confirmar, vincula **y agrega el teléfono nuevo** a su perfil (escenario "cambió/otro número / número obsoleto").
    - 0 total → **crear paciente rápido** (nombre+teléfono prellenados) y vincular (escenario "nuevo no registrado").
  - **UI "Bandeja sin asignar":** por cada cita, sugerencia + botones [Vincular a sugerido] / [Elegir otro (typeahead)] / [Crear paciente]; + botón "Auto-vincular coincidencias exactas". Meta: 1–2 clicks máximo.
  - **Registro rápido:** permitir crear paciente con solo nombre+teléfono (revisar columnas NOT NULL de `pacientes`; endpoint `POST /pacientes/quick` o migración + flag `registro_incompleto`).
  - El vínculo se estampa en `extendedProperties.clinicPatientId` (ya soportado por `linkToPatient`). No se toca Confirmafy.
- **Notificaciones propias (recordatorio extra):** al reagendar/cancelar desde la app,
  disparar un webhook a **n8n** (recomendado, en el home-lab) → WhatsApp (Twilio/Meta
  Cloud API, requiere plantillas aprobadas) o email de respaldo. Cubre el caso en que
  Confirmafy no propaga el cambio. Con toggle "avisar al paciente" + idempotencia +
  bitácora. Alternativa simple: Twilio directo desde el backend.

## Fase 3 (después) — mirror + tiempo real
- Tabla `appointments` espejo + `incrementalSync` con `syncToken`.
- Webhook `events.watch` (requiere dominio HTTPS — ya tienes el túnel).
