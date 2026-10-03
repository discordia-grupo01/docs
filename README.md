# docs

Documentación central de Discordia: contratos entre servicios, diagramas y
decisiones de arquitectura.

## Contenido

| Carpeta | Qué hay |
|---|---|
| [`asyncapi/asyncapi.yaml`](asyncapi/asyncapi.yaml) | Dominio membership (altas/bajas/bans de miembros de un servidor). |
| [`asyncapi/channels.yaml`](asyncapi/channels.yaml) | Dominio channels (alta/baja de canales), consumido por `messaging`. |
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
| `servers.member_joined` | discordia-servers | discordia-identify | `asyncapi.yaml` |
| `servers.member_left` | discordia-servers | discordia-identify | `asyncapi.yaml` |
| `servers.member_banned` | discordia-servers | — (futuro: mensajería, voz, auditoría) | `asyncapi.yaml` |
| `servers.member_unbanned` | discordia-servers | — | `asyncapi.yaml` |
| `users.profile_updated` | discordia-identify | discordia-servers |
| `servers.channel_created` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `channels.yaml` |
| `servers.channel_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `channels.yaml` |
| `servers.server_deleted` | discordia-servers | discordia-messaging (cola `messaging.channel_lifecycle`) | `channels.yaml` |


## Cambiar un evento

1. Editar `asyncapi/asyncapi.yaml` y validarlo:
   ```bash
   npx @asyncapi/cli validate asyncapi/asyncapi.yaml
   ```
2. Replicar el cambio en `events-contract` y taguear una versión nueva.
3. Actualizar publisher(s) y consumer(s). Un cambio que rompe compatibilidad
   (renombrar o sacar un campo) se despliega en publisher y consumers juntos.
