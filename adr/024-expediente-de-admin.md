# ADR-024: admin arma el expediente de investigación con una réplica alimentada por eventos

**Estado:** Aceptada  
**Fecha**: 2026-11-08  
**Servicios**: `admin`, `servers`, `events-contract`, `docs` (AsyncAPI), `backoffice`  
**Decidida por**: Manuel Peñalva (diseño e implementación del backend)  
**Historia**: "Ver expediente de investigación de usuario o servidor" (#81): CA1 expediente de usuario, CA2 expediente de servidor, CA3 sin permisos  
**Relacionadas**: ADR 07 (Mensajería Pub/Sub), ADR-017 (réplica local por eventos), ADR-020 (sin llamadas HTTP entre servicios), ADR-022 (reportes)

## 1. Contexto

El staff necesita una vista única para investigar a un usuario o a un servidor. Los datos que pide la historia viven en servicios distintos:

- **Estado de la cuenta, fecha de registro y membresías**: réplica de admin (alimentada por identify y servers).
- **Reportes**: tabla reports de servers (ADR-022). No se publicaban eventos.
- **Acciones de los moderadores** (ban, unban, kick, mute, unmute): tabla moderation_audit_entries de servers. Tampoco se publicaban.
- **Acciones del staff** (suspensiones, reactivaciones, pedidos de eliminación): admin, pero solo el estado actual, sin historial.
- **Actividad de mensajería**: messaging, que ya publica messaging.message_created.

La consigna pide comunicación asíncrona entre servicios por defecto, y admin ya arma sus listados (#31, #32) con una réplica propia.

## 2. Decisión

Admin responde el expediente solo con datos locales:

- Consume **messaging.message_created** en una cola nueva, admin.activity, y guarda por mensaje: autor, servidor, canal, nombre del canal y momento. **Nunca guarda ni loguea el texto** (content_preview).
- **servers publica dos eventos nuevos** por su outbox, en la misma transacción que la escritura: servers.report_updated (foto completa del reporte, al crearlo y al cerrarlo) y servers.moderation_action_recorded (uno por cada fila de auditoría). Los dos tienen backfill. No llevan a quien reportó, a quien resolvió ni al moderador que actuó (minimización de datos).
- Admin registra las **acciones de su propio staff** en una tabla de historial, en la misma transacción que la acción. El historial anterior se reconstruye desde su outbox.
- El **autor de un mensaje reportado se resuelve al consultar**, cruzando el message_id del reporte con la actividad registrada. Así no importa en qué orden lleguen los eventos.
- **Borrar un servidor** en servers es físico (CASCADE). Al recibir servers.server_deleted, admin borra en espejo sus reportes, su actividad y su moderación de servidor, y conserva las acciones del staff como registro de la plataforma.
- La actividad se conserva **90 días** (ACTIVITY_RETENTION_DAYS).
- Cuatro endpoints GET bajo /v1/admin (resumen y páginas por sección, de usuario y de servidor), protegidos por la tabla staff_members (CA3).

## 3. Alternativas descartadas

- **Consultar por HTTP a servers y messaging al abrir el expediente**: acopla la disponibilidad del backoffice a tres servicios y exige un ADR de excepción a la comunicación asíncrona.
- **Consumir servers.member_banned, member_kicked, member_muted, etc.**: hacer el backfill de esos eventos volvería a ejecutar sus efectos en los consumidores actuales (por ejemplo, volvería a silenciar a alguien). Un evento de auditoría aparte no tiene ese problema.
- **Guardar el texto de los mensajes**: la historia no lo pide y va contra la minimización de datos.
- **Backfill de los mensajes anteriores**: re-publicar message_created volvería a disparar las notificaciones push.
- **Resolver el autor del mensaje reportado al recibir el reporte**: depende de que message_created llegue antes, lo que RabbitMQ no garantiza.

## 4. Consecuencias

### Positivas

- El expediente funciona aunque servers, identify o messaging estén caídos.
- Todos los consumidores son idempotentes y toleran desorden: los reportes se quedan con la foto más nueva, y las acciones y la actividad se deduplican por su id.
- Cubre lo que pide la consigna, además del acceso desde un reporte al expediente del reportado y las acciones desde el propio expediente.

### Negativas y límites

- Consistencia eventual: un cambio tarda unos segundos en verse.
- La actividad de mensajes empieza en el deploy; la mensajería de los últimos 7 días se completa en una semana.
- Un reporte de un mensaje anterior al deploy, o de más de 90 días, queda sin autor.
- Un evento más por mensaje en el bus; la cola admin.activity tiene su DLQ (admin.activity.dlq).
- Un reporte de mensaje de un canal borrado desaparece en servers sin evento; admin lo conserva hasta que se borre el servidor o pase la retención.
- Orden de despliegue obligatorio: admin antes que servers. Si no, el backfill se publica sin la cola de admin y se pierde (misma lección que ADR-017).
