# docs

Documentación central de Discordia: contratos entre servicios, diagramas y
decisiones de arquitectura.

## Contenido

| Carpeta | Qué hay |
|---|---|
| [`asyncapi/`](asyncapi/asyncapi.yaml) | Contrato del event bus (RabbitMQ, exchange `discordia.events`): cada evento, su routing key, su payload y quién lo publica/consume. Es la fuente de verdad del schema; las implementaciones Go viven en [`events-contract`](https://github.com/discordia-grupo01/events-contract). |

## Eventos documentados

| Routing key | Publica | Consume |
|---|---|---|
| `servers.member_joined` | discordia-servers | discordia-identify |
| `servers.member_left` | discordia-servers | discordia-identify |
| `servers.member_banned` | discordia-servers | — (futuro: mensajería, voz, auditoría) |
| `servers.member_unbanned` | discordia-servers | — |

## Cambiar un evento

1. Editar `asyncapi/asyncapi.yaml` y validarlo:
   ```bash
   npx @asyncapi/cli validate asyncapi/asyncapi.yaml
   ```
2. Replicar el cambio en `events-contract` y taguear una versión nueva.
3. Actualizar publisher(s) y consumer(s). Un cambio que rompe compatibilidad
   (renombrar o sacar un campo) se despliega en publisher y consumers juntos.
