# docs

Documentación central de Discordia: contratos entre servicios, diagramas y
decisiones de arquitectura.

## Contenido

| Carpeta | Qué hay |
|---|---|
| [`asyncapi/asyncapi.yaml`](asyncapi/asyncapi.yaml) | Dominio membership (altas/bajas/bans de miembros de un servidor). |
| [`asyncapi/channels.yaml`](asyncapi/channels.yaml) | Dominio channels (alta/baja de canales), consumido por `messaging`. |
| [`asyncapi/permissions.yaml`](asyncapi/permissions.yaml) | Dominio permissions (roles, roles de cada miembro, overrides por canal y dueño del servidor), que `messaging` replica para autorizar sin consultar a `servers`. |
| [`asyncapi/admin.yaml`](asyncapi/admin.yaml) | Dominio admin (suspensión y reactivación de cuentas por el staff, eventos firmados con HMAC), que identify, servers, messaging y voz consumen para bloquear al usuario. |
| [`adr/`](adr/) | Registro de decisiones de arquitectura (ADRs). |

Cada dominio es un documento AsyncAPI aparte (no uno solo gigante): mismo
exchange `discordia.events` compartido, pero cada archivo es autocontenido
(duplica `Meta`/`channelBindings` en vez de referenciarlos entre archivos).
Es la fuente de verdad del schema; las implementaciones viven en
[`events-contract`](https://github.com/discordia-grupo01/events-contract)
(Go y, cuando aplica, el binding del lenguaje del consumidor).

## Eventos documentados

| Routing key | Publica | Consume | Documento |
|---|---|---|---|
| `servers.member_joined` | discordia-servers | discordia-identify, discordia-admin (cola `admin.servers`) | `asyncapi.yaml` |
| `servers.member_left` | discordia-servers | discordia-identify, discordia-admin (cola `admin.servers`) | `asyncapi.yaml` |
| `servers.member_banned` | discordia-servers | — (futuro: mensajería, voz, auditoría) | `asyncapi.yaml` |
| `servers.member_unbanned` | discordia-servers | — | `asyncapi.yaml` |
| `servers.member_kicked` | discordia-servers | — (futuro: notificaciones) | `asyncapi.yaml` |
| `servers.word_filter_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `asyncapi.yaml` |
| `users.profile_updated` | discordia-identify | discordia-servers, discordia-messaging (cola `messaging.channel_lifecycle`), discordia-admin (cola `admin.users`) | `asyncapi.yaml` |
| `users.account_registered` | discordia-identify | discordia-admin (cola `admin.users`); lleva el email, no suscribir a otros servicios | `asyncapi.yaml` |
| `servers.channel_created` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `channels.yaml` |
| `servers.channel_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`) | `channels.yaml` |
| `servers.server_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`), discordia-admin (cola `admin.servers`) | `channels.yaml` |
| `servers.server_updated` | discordia-servers | discordia-admin (cola `admin.servers`) | `channels.yaml` |
| `servers.channel_access_revoked` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`), discordia-voice-sfu (cola `voice.signaling`) | `channels.yaml` |
| `servers.role_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `permissions.yaml` |
| `servers.role_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `permissions.yaml` |
| `servers.member_roles_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `permissions.yaml` |
| `servers.channel_overrides_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `permissions.yaml` |
| `servers.owner_updated` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `permissions.yaml` |
| `admin.user_suspended` | discordia-admin (firmado con HMAC) | discordia-identify (cola `identify.user_suspension`), discordia-servers (`servers.user_suspension`), discordia-messaging (`messaging.user_suspension`), discordia-voice-sfu (`voice.user_suspension`) | `admin.yaml` |
| `admin.user_reactivated` | discordia-admin (firmado con HMAC) | los mismos que `admin.user_suspended` | `admin.yaml` |

## Cambiar un evento

1. Editar `asyncapi/asyncapi.yaml` y validarlo:
   ```bash
   npx @asyncapi/cli validate asyncapi/asyncapi.yaml
   ```
2. Replicar el cambio en `events-contract` y taguear una versión nueva.
3. Actualizar publisher(s) y consumer(s). Un cambio que rompe compatibilidad
   (renombrar o sacar un campo) se despliega en publisher y consumers juntos.
