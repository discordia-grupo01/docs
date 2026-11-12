# docs

Documentación central de Discordia: contratos entre servicios, diagramas y
decisiones de arquitectura.

## Contenido

| Carpeta | Qué hay |
|---|---|
| [`asyncapi/asyncapi.yaml`](asyncapi/asyncapi.yaml) | Dominio membership (altas/bajas/bans de miembros de un servidor). |
| [`asyncapi/channels.yaml`](asyncapi/channels.yaml) | Dominio channels (alta/baja de canales), consumido por `messaging`. |
| [`asyncapi/permissions.yaml`](asyncapi/permissions.yaml) | Dominio permissions (roles, roles de cada miembro, overrides por canal y dueño del servidor), que `messaging` replica para autorizar sin consultar a `servers`. |
| [`asyncapi/messages.yaml`](asyncapi/messages.yaml) | Dominio messages (actividad de mensajería: mensaje creado en un canal, mensaje directo creado y cambios de presencia del usuario), que `messaging` publica y `notifications` consume para los indicadores de no leído, el historial de notificaciones y las notificaciones push. |
| [`asyncapi/admin.yaml`](asyncapi/admin.yaml) | Dominio admin (suspensión y reactivación de cuentas, y suspensión, reactivación y eliminación de servidores, por el staff; eventos firmados con HMAC), que identify, servers, messaging y voz consumen para bloquear al usuario o al servidor. |
| [`asyncapi/billing.yaml`](asyncapi/billing.yaml) | Dominio billing (estado de Premium de cada usuario, evento firmado con HMAC), que identify y messaging replican para dar los beneficios de Premium. |
| [`asyncapi/messaging-broadcast.yaml`](asyncapi/messaging-broadcast.yaml) | Canal interno de `messaging`: los 13 eventos que sus instancias se mandan por el exchange `messaging.broadcast` (fanout). **Generado** con `eventsgen docs-sync`, no se edita a mano. |
| [`asyncapi/boosts.yaml`](asyncapi/boosts.yaml) | Saga para boostear un servidor entre billing y servers (eventos firmados con HMAC) y foto del nivel, que `messaging` replica. |
| [`c4/`](c4/) | Diagramas C4: contexto del sistema, contenedores y componentes de `messaging`. |
| [`adr/`](adr/) | Registro de decisiones de arquitectura (ADRs). |
| [`reintentos-y-dlq.md`](reintentos-y-dlq.md) | Política de reintentos con espera creciente y cola de eventos fallidos (DLQ) de todos los consumidores, y cómo revisar y reinyectar un evento apartado. |

Cada dominio es un documento AsyncAPI aparte (no uno solo gigante): mismo
exchange `discordia.events` compartido, pero cada archivo es autocontenido
(duplica `Meta`/`channelBindings` en vez de referenciarlos entre archivos).
Los campos, tipos y formatos de cada evento los define `events-contract` (structs de
Go): de ahí se generan solos los JSON Schema, los ejemplos y un AsyncAPI completo, y el
CI de este repo comprueba que estos documentos coincidan. Acá se explica el sentido de
cada evento.

## Eventos documentados

| Routing key | Publica | Consume | Documento |
|---|---|---|---|
| `servers.member_joined` | discordia-servers | discordia-identify, discordia-admin (cola `admin.servers`), discordia-notifications (cola `notifications.unread_state`) | `asyncapi.yaml` |
| `servers.member_left` | discordia-servers | discordia-identify, discordia-admin (cola `admin.servers`), discordia-notifications (cola `notifications.unread_state`) | `asyncapi.yaml` |
| `servers.member_banned` | discordia-servers | — (futuro: mensajería, voz, auditoría) | `asyncapi.yaml` |
| `servers.member_unbanned` | discordia-servers | — | `asyncapi.yaml` |
| `servers.member_kicked` | discordia-servers | — (futuro: notificaciones) | `asyncapi.yaml` |
| `servers.word_filter_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `asyncapi.yaml` |
| `servers.report_updated` | discordia-servers | discordia-admin (cola `admin.servers`); foto del reporte para el expediente de investigación, sin quien reportó ni quien resolvió | `asyncapi.yaml` |
| `servers.moderation_action_recorded` | discordia-servers | discordia-admin (cola `admin.servers`); una por fila de auditoría de moderación, sin actor, para el expediente de investigación | `asyncapi.yaml` |
| `users.profile_updated` | discordia-identify | discordia-servers, discordia-messaging (cola `messaging.channel_lifecycle`), discordia-admin (cola `admin.users`) | `asyncapi.yaml` |
| `users.account_registered` | discordia-identify | discordia-admin (cola `admin.users`); lleva el email, no suscribir a otros servicios | `asyncapi.yaml` |
| `users.email_verified` | discordia-identify | discordia-admin (cola `admin.users`); solo para el estado "pendiente" del backoffice, no suscribir a otros servicios | `asyncapi.yaml` |
| `servers.channel_created` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `channels.yaml` |
| `servers.channel_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`), discordia-notifications (cola `notifications.unread_state`) | `channels.yaml` |
| `servers.server_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`), discordia-admin (cola `admin.servers`), discordia-notifications (cola `notifications.unread_state`), discordia-billing (cola `billing.servers_events`) | `channels.yaml` |
| `servers.server_updated` | discordia-servers | discordia-admin (cola `admin.servers`) | `channels.yaml` |
| `servers.emoji_created` | discordia-servers | discordia-messaging (cola `messaging.server_emojis`) | `channels.yaml` |
| `servers.emoji_deleted` | discordia-servers | discordia-messaging (cola `messaging.server_emojis`) | `channels.yaml` |
| `servers.channel_access_revoked` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`) | `channels.yaml` |
| `servers.role_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `permissions.yaml` |
| `servers.role_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `permissions.yaml` |
| `servers.member_roles_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `permissions.yaml` |
| `servers.channel_overrides_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `permissions.yaml` |
| `servers.owner_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-notifications (cola `notifications.unread_state`) | `permissions.yaml` |
| `messaging.message_created` | discordia-messaging | discordia-notifications (cola `notifications.unread_state`), discordia-admin (cola `admin.activity`, descarta `content_preview`); lleva ids, más `channel_name` y `content_preview` opcionales solo para el push | `messages.yaml` |
| `messaging.direct_message_created` | discordia-messaging | discordia-notifications (cola `notifications.unread_state`); lleva ids, más `content_preview` opcional solo para el push | `messages.yaml` |
| `messaging.message_updated` | discordia-messaging | discordia-notifications (cola `notifications.unread_state`); agrega o quita la mención en el historial y avisa al recién mencionado | `messages.yaml` |
| `messaging.message_deleted` | discordia-messaging | discordia-notifications (cola `notifications.unread_state`); borra las entradas del historial del mensaje | `messages.yaml` |
| `messaging.user_presence_changed` | discordia-messaging | discordia-notifications (cola `notifications.unread_state`); decide si se manda un push | `messages.yaml` |
| `admin.user_suspended` | discordia-admin (firmado con HMAC) | discordia-identify (cola `identify.admin_events`), discordia-servers (`servers.admin_events`), discordia-messaging (`messaging.admin_events`), discordia-voice-sfu (`voice.signaling.<instance_id>.suspensions`) | `admin.yaml` |
| `admin.user_reactivated` | discordia-admin (firmado con HMAC) | los mismos que `admin.user_suspended` | `admin.yaml` |
| `admin.server_suspended` | discordia-admin (firmado con HMAC) | discordia-servers (cola `servers.admin_events`), discordia-messaging (`messaging.admin_events`), discordia-voice-sfu (`voice.signaling.<instance_id>.suspensions`) | `admin.yaml` |
| `admin.server_reactivated` | discordia-admin (firmado con HMAC) | discordia-servers (cola `servers.admin_events`), discordia-messaging (`messaging.admin_events`) | `admin.yaml` |
| `admin.server_deletion_requested` | discordia-admin (firmado con HMAC) | discordia-servers (cola `servers.admin_events`), que borra el servidor y publica `servers.server_deleted`; es un pedido, no el hecho consumado | `admin.yaml` |
| `billing.premium_updated` | discordia-billing (firmado con HMAC) | discordia-identify (cola `identify.billing_events`), discordia-messaging (`messaging.billing_events`) | `billing.yaml` |
| `billing.server_boost_requested` | discordia-billing (firmado con HMAC) | discordia-servers (cola `servers.billing_events`) | `boosts.yaml` |
| `billing.server_boost_cancelled` | discordia-billing (firmado con HMAC) | discordia-servers (cola `servers.billing_events`) | `boosts.yaml` |
| `billing.server_boost_removed` | discordia-billing (firmado con HMAC) | discordia-servers (cola `servers.billing_events`) | `boosts.yaml` |
| `servers.server_boost_applied` | discordia-servers (firmado con HMAC) | discordia-billing (cola `billing.servers_events`) | `boosts.yaml` |
| `servers.server_boost_rejected` | discordia-servers (firmado con HMAC) | discordia-billing (cola `billing.servers_events`) | `boosts.yaml` |
| `servers.server_boost_updated` | discordia-servers | discordia-messaging (cola `messaging.server_boosts`) | `boosts.yaml` |

## Cambiar un evento

1. Cambiar la struct (y la etiqueta `contract` si hace falta) en
   [`events-contract`](https://github.com/discordia-grupo01/events-contract), correr
   `go run ./cmd/eventsgen gen` y commitear lo generado. El CI de ese repo avisa si el
   cambio rompe a publicadores o consumidores existentes.
2. Actualizar el documento de `asyncapi/` que corresponda (la explicación en prosa y los
   campos) y comprobarlo desde una copia de `events-contract`:
   ```bash
   go run ./cmd/eventsgen docs-check ../docs/asyncapi
   ```
   Para el canal interno de `messaging`: `go run ./cmd/eventsgen docs-sync ../docs/asyncapi`.
3. Taguear una versión nueva de `events-contract` y actualizar publisher(s) y consumer(s).
   Un cambio que rompe compatibilidad (renombrar o sacar un campo) se despliega en
   publisher y consumers juntos, y se hace en dos pasos.
