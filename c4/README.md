# Diagramas C4

Los tres niveles del [modelo C4](https://c4model.com) de Discordia, escritos en Mermaid (sintaxis `C4Context`, `C4Container` y `C4Component`). GitHub los dibuja directamente al abrir cada archivo.

| Nivel | Archivo | Qué responde |
|---|---|---|
| 1. Contexto | [`01-contexto.md`](01-contexto.md) | Quién usa Discordia y con qué sistemas de terceros se integra. |
| 2. Contenedores | [`02-contenedores.md`](02-contenedores.md) | Qué aplicaciones y almacenes de datos la componen, con qué tecnología y cómo se comunican (REST, eventos, WebSocket). |
| 3. Componentes | [`03-componentes-messaging.md`](03-componentes-messaging.md) | Cómo está hecho por dentro `messaging`, el servicio más grande: tiempo real, outbox y réplica local de permisos. |

## Cómo mantenerlos

- Si se agrega un servicio, una base o una integración nueva, se actualiza el nivel 2 (y el nivel 1 si es un sistema externo).
- Si cambia la estructura de `messaging/lib`, se actualiza el nivel 3.
- Los diagramas son texto: se revisan en el PR como cualquier otro cambio.
- Los eventos concretos entre servicios (campos, quién publica y quién consume) no se repiten acá: están en [`asyncapi/`](../asyncapi) y en [`README.md`](../README.md).
