# ADR-020: notifications: indicadores de no leído derivados de eventos, sin llamadas HTTP entre servicios

**Estado:** Aceptada  
**Fecha**: 2026-10-23  
**Servicios**: `notifications` (nuevo), `messaging` (publica un evento nuevo), `events-contract`, `docs` (AsyncAPI), `gateway` (Kong), `infrastructure`  
**Decidida por**: Facundo Madotta (diseño, implementación y pruebas)  
**Historia**: "Ver notificaciones no leídas": CA1 indicador por canal, CA2 indicador por servidor, CA3 mención destacada (optativa)  
**Relacionadas**: ADR-016 (propagación en tiempo real), ADR-014 (ticket del WebSocket), ADR-017 (réplica local de permisos)

## 1. Contexto

La historia pide saber, por canal y por servidor, si hay algo sin leer, y distinguir las menciones. Para eso hace falta conocer tres cosas que viven en servicios distintos:

- **qué mensajes se escribieron** (`messaging`),
- **quién puede ver cada canal** (`servers`: miembros, roles, overrides, dueño),
- **hasta dónde leyó cada usuario** (no lo guarda nadie todavía).

Ya existía un repo `notifications` vacío (la plantilla). La indicación fue seguir el mismo alineamiento que `messaging` y, como es un servicio de eventos, **no hacer pedidos HTTP entre servicios**.

## 2. Decisión

### 2.1 Todo lo que el servicio sabe llega por eventos

`notifications` consume de `discordia.events` (exchange topic) con **una cola durable propia**, `notifications.unread_state`:

- **`messaging.message_created` (nuevo)**: actividad del canal y menciones
- **`servers.channel_created` / `channel_deleted` / `server_deleted`**: qué canales existen
- **`servers.member_joined` / `member_left`**: membresía y momento de ingreso
- **`servers.member_roles_updated` / `role_updated` / `role_deleted` / `channel_overrides_updated` / `owner_updated`**: permisos

Los eventos de `servers` ya se publicaban; con ellos se arma una **réplica local de permisos en Mongo**, igual que en el ADR-017 (el módulo de permisos es el mismo cálculo que usa `messaging`). Así `notifications` sabe qué canales de texto puede ver cada usuario (`VIEW_CHANNELS`) sin preguntarle a `servers`.

### 2.2 Un evento nuevo en messaging: messaging.message_created

`messaging` no publicaba nada al bus de dominio cuando se escribía un mensaje (solo avisaba a sus propios sockets). Se agregó `messaging.message_created`, que sale por **el mismo outbox** que el resto (ADR-018), en la misma transacción que el mensaje.

El payload lleva **solo ids**: `server_id`, `channel_id`, `message_id`, `author_id`, `mentioned_user_ids`, `occurred_at`. **Nunca el contenido** (minimización de datos: `notifications` no necesita saber qué se dijo). No se publica para mensajes directos (no tienen servidor ni permisos por canal). El contrato está en `events-contract` y en el AsyncAPI de `docs`.

### 2.3 El estado se deriva comparando ids; no hay contadores

Se guarda, por canal, el id del **último mensaje**; por usuario y canal, el id **hasta donde leyó** y el id de **la última mención**. Los ids de mensaje son UUIDv7, que ordenan por tiempo, así que:

```
no leído  =  último_mensaje  >  max(leído_hasta, momento_de_ingreso)
```

```
mención   =  última_mención  >  max(leído_hasta, momento_de_ingreso)
```

Todas las escrituras son `$max` (solo avanzan). Consecuencias buscadas:

- **Idempotente**: procesar dos veces el mismo evento, o fuera de orden, deja el mismo estado. Es lo que permite el *at-least-once* de RabbitMQ sin tablas de deduplicación para los mensajes.
- **Sin sumas que se desincronicen** (nada de "+1 al llegar, -N al leer").
- **Línea base por ingreso**: `max(..., floor_v7(joined_at))`. Quien entra a un servidor no ve como no leído todo el historial anterior.
- Los mensajes **propios** no encienden el canal y marcan como leído lo anterior.
- Una mención solo destaca mientras sea posterior a la línea base; un mensaje común posterior no la apaga, leer el canal sí.

### 2.4 Booleanos, no cantidades

La historia habla de un *indicador* (hay/no hay), no de un número. Se entrega `unread` y `mention` por canal y por servidor. Contar mensajes obligaría a guardar contadores (2.3) o a contar en cada consulta; se descartó porque nadie lo pidió.

### 2.5 Entrega en vivo: WebSocket propio, con una excepción HTTP

El estado viaja por un **canal Phoenix propio** (`notifications:<user_id>` en `/notifications/socket`): al unirse se empuja un `snapshot` con lo que está sin leer y después `unread_updated` solo cuando cambian los indicadores. El cliente manda `mark_read`.

El navegador no puede mandar `Authorization` al abrir un WebSocket (ADR-014), así que se repite el patrón de `messaging`: un **ticket de un solo uso, 30 s**, que se pide con `POST /v1/notifications/socket-tickets` (Kong valida el JWT) y se guarda en Mongo. Es **la única llamada HTTP** del servicio, y es del cliente hacia `notifications`, no entre servicios.

Se descartó reutilizar el socket de `messaging`: acoplaría el despliegue y la disponibilidad de dos servicios, y `messaging` pasaría a conocer un concepto (lo no leído) que no es suyo.

### 2.6 Una sola instancia, sin distribución

`notifications` **no es distribuido**: corre una instancia (decisión del equipo). La instancia consume la cola, escribe en Mongo y avisa a sus sockets con `Endpoint.broadcast`. No hay fanout entre instancias, ni exchange extra, ni colas por instancia.

Se mantiene la regla de que nada importante vive en memoria: el estado está en Mongo y cada socket guarda solo una copia de trabajo de *su* usuario, que se reconstruye desde Mongo ante un `resync`. Si en el futuro hiciera falta escalar, habría que agregar el reparto de avisos entre instancias (como hace `messaging`, ADR-016); hoy queda fuera de alcance.

### 2.7 Arranque sobre datos existentes

La cola de `notifications` nace vacía y RabbitMQ no guarda lo publicado antes. El backfill de `servers` (migración 0022) re-publica roles, miembros, overrides y dueño, pero no los canales. Para no pedir cambios en `servers`, un `messaging.message_created` de un canal desconocido lo da de alta como canal de texto (un mensaje solo existe en canales de texto), salvo que el canal figure borrado. La línea base de cada miembro es el momento en que el servicio lo vio por primera vez, así que el historial anterior al deploy no aparece como no leído.

### 2.8 Marcar como leído

Historia "Marcar notificaciones como leídas". Abrir un canal es `mark_read` (por canal, ya existente); "marcar todo" es `mark_all_read`: para cada canal visible con contenido sin leer, el marcador sube al último mensaje del canal, en una sola escritura en bloque (`$max`, idempotente, nunca retrocede). Solo se escriben los canales realmente sin leer. Después se publica un `resync` a las sesiones del usuario, que reciben un `snapshot` vacío; así todas convergen al estado guardado y no hay que repartir una notificación por canal. No se agregó "marcar un servidor": no lo pide la historia y se puede hacer con un `mark_read` por canal.

### 2.9 Orden de eventos de servers

Igual que en `messaging`: un reloj por entidad (`event_clocks`), gana el evento más nuevo por `occurred_at`, los borrados dejan una lápida con TTL de 7 días. Además, al rejoin de un usuario que se había ido, la membresía vuelve como nueva (con su propio momento de ingreso).

## 3. Alternativas descartadas

- **Que `notifications` consulte por HTTP a `messaging` y `servers`**: Era justo lo que se pidió evitar; acopla disponibilidad y multiplica la latencia del `snapshot`.
- **Contadores de no leídos**: Se desincronizan ante reentregas o fallos parciales; la historia no pide números.
- **Meter lo no leído dentro de `messaging`**: Mezcla responsabilidades y ya existía el repo `notifications` para esto.
- **Publicar el contenido del mensaje en el evento**: Innecesario para la historia y expone datos de más al bus.
- **Polling del cliente**: La historia es de tiempo real; ya hay infraestructura de WebSocket.

## 4. Consecuencias y límites

- **El orden depende de los relojes de `messaging`.** Los UUIDv7 se generan en cada instancia de `messaging`; entre mensajes concurrentes el orden es el del reloj de cada una (desfase de milisegundos). Es el mismo límite que ya tiene el historial.
- **`mark_read` acepta ids que todavía no llegaron.** El cliente ve el mensaje en vivo por `messaging` antes de que `notifications` procese su evento. Si se recortara al último mensaje conocido, el canal se encendería justo después de leerlo. Se acepta cualquier UUIDv7 que no esté más de 60 s en el futuro; el peor caso de un id mal puesto es que el propio usuario se oculte sus avisos.
- **Fuera de alcance**: eventos de suspensión de usuarios, DMs (no hay evento), menciones agregadas al editar un mensaje, conteos, notificaciones push al celular, integración en el web-client.
- **Cola de errores (DLQ)**: un evento que falla se reintenta indefinidamente con espera; no hay cola de eventos muertos (es un pendiente común a todos los consumidores, ver `planes/pendientes-manejo-de-eventos.md`).
