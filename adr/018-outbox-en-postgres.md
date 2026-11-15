# ADR-018: Outbox transaccional de messaging en Postgres, con los mensajes en Mongo

**Estado:** Aceptada  
**Fecha**: 2026-10-13  
**Servicios**: `messaging`, `infrastructure` (compose local), Supabase (Postgres de producción)  
**Decidida por**: Facundo Madotta (diseño e implementación)  
**Pedida por**: Revisión semanal del 2026-10-09: "Outbox hacerlo como servers (con Postgres)"

## 1. Contexto

Cuando se envía un mensaje, `messaging` hace dos cosas en sistemas distintos: **guarda el mensaje en Mongo** y **avisa a las demás instancias por RabbitMQ** para que lo entreguen a sus clientes conectados. No hay forma de hacer las dos de manera atómica, y fallaban así:

- Si el proceso moría, o RabbitMQ no respondía, entre una y otra, el aviso se perdía: el mensaje existía pero nadie conectado lo recibía.
- `:ok = Broadcaster.publish(...)` hacía que un RabbitMQ caído cerrara el canal de quien enviaba.
- Lo mismo valía para ediciones, borrados, mensajes directos, menciones, reacciones y `access_revoked`.

`servers` e `identify-service` ya resuelven este problema con un outbox transaccional en Postgres. Los mensajes de `messaging` **tienen que seguir en Mongo** (es su modelo de datos), así que el outbox vive en un Postgres aparte.

## 2. Decisión

### 2.1 Anotar primero, escribir después

Cada vez que algo se tiene que avisar, el evento se **anota en Postgres antes de tocar Mongo**:

```
enviar / editar / borrar ──▶ 1. INSERT en outbox_events          (si falla: 503 MESSAGES_UNAVAILABLE, no se toca Mongo)
```

```
                             2. escribe en Mongo                  (si falla: el mensaje ya está aceptado, ver más abajo)
```

```
                             3. responde OK
```

```
poller ──▶ completa Mongo si falta ──▶ publica en RabbitMQ ──▶ espera la confirmación ──▶ marca publicado
```

Cada fila trae lo necesario para **terminar el trabajo** si la instancia muere en el medio: el evento (`payload`) y una instrucción (`apply`) para dejar Mongo en el estado correcto (`insert_message`, `update_message` o `delete_message`). Esas escrituras son idempotentes (`upsert` con `$setOnInsert`, actualizaciones que solo afectan mensajes vivos), así que se pueden repetir sin efecto.

Si Mongo falla **después** de anotar, el pedido no se rechaza: el mensaje ya está aceptado de forma durable y el poller lo completa. Es lo contrario de lo que habría que hacer sin outbox.

### 2.2 El poller

`Messaging.Outbox.Poller` corre en cada instancia (cada 1 segundo y además apenas se anota un evento, para que el tiempo real no pierda latencia). En una transacción toma un lote con `FOR UPDATE SKIP LOCKED`, lo procesa y marca el resultado:

- **Varias instancias a la vez:** `SKIP LOCKED` hace que dos pollers nunca tomen la misma fila. Si una instancia muere a mitad de lote, su transacción se revierte y las filas quedan para otra.
- **Orden por mensaje:** una fila no se toma mientras exista otra anterior, no publicada, del mismo `message_id`. Así `new_message`, `message_updated` y `message_deleted` de un mismo mensaje salen en orden aunque haya varios pollers.
- **Publicación con confirmación:** el publicador usa *publisher confirms* y pone el id del evento como `message_id` de RabbitMQ. Una fila solo se marca publicada si el broker confirmó.

### 2.3 Qué se guarda y por cuánto

Tabla `outbox_events`: `id` (UUIDv7), `event`, `topic`, `payload` y `apply` (JSONB), `message_id`, `channel_id`, `created_at`, `published_at`, `attempts`, `last_error`.

- **Las filas no se borran nunca** (auditoría: poder responder "qué pasó con tal evento").
- **Al publicar se vacían `payload` y `apply`**: el texto de los mensajes no queda en Postgres. Quedan el tipo de evento, los ids, las fechas, los intentos y el último error.

### 2.4 Reintentos

- RabbitMQ caído o que no confirma: se reintenta sin límite y **sin gastar intentos** (no es culpa de la fila); queda `last_error`.
- Una fila que no se puede interpretar cuenta un intento; a los 10 deja de intentarse y queda a la vista en la tabla.

### 2.5 Dónde corre Postgres

- **Producción:** un schema `messaging` en el proyecto de Supabase compartido (un schema por servicio, como `servers` e `identify-service`), por el *Session pooler*. Las tablas se califican siempre con el schema.
- **Migraciones:** `messaging/migrations/*.up.sql` con `golang-migrate`, desde el CI/CD: un job `migrate` corre antes del deploy y, si falla, no se despliega.
- **Local y CI:** un Postgres propio en el compose y como servicio del CI.

## 3. Alternativas descartadas

- **Outbox en Mongo (misma base que los mensajes)**: Sin transacciones multi-documento entre colecciones no hay más atomicidad que hoy, y el pedido era que fuera como `servers` (Postgres).
- **Escribir en Mongo y después anotar en el outbox**: Deja una ventana (proceso muerto entre las dos) en la que el mensaje existe y el evento no. Con "anotar primero" la ventana es de un evento de más, nunca de uno de menos.
- **Publicar directo y reintentar en memoria**: Se pierde si la instancia muere, y el pedido era "nada en memoria".
- **Change streams de Mongo**: Exige replica set, ata el aviso al driver de Mongo y no cubre eventos que no son documentos (`access_revoked`).
- **Inbox en Postgres para evitar duplicados**: Una fila por evento y por instancia en el camino del tiempo real. El consumo ya es idempotente (el cliente deduplica por `id`; las fotos de permisos se descartan si son viejas); ver sección 4.

## 4. Consecuencias

### Positivas

- Un RabbitMQ que se cae o se reinicia ya no pierde eventos ni cierra el canal de quien envía.
- Una instancia que muere después de anotar no deja mensajes a medio guardar.
- Hay un registro permanente de cada aviso: cuándo se anotó, cuándo salió, cuántos intentos y por qué falló.
- Varias instancias pueden correr el poller a la vez sin coordinarse.

### Negativas y riesgos conocidos

1. **Entrega "al menos una vez".** Si el proceso muere entre publicar y marcar, el evento sale dos veces con el mismo `id`. El servidor no guarda estado en memoria para evitarlo (regla del proyecto); los clientes deduplican por el `id` del mensaje. Las repeticiones son inofensivas: un mensaje, una edición o un borrado repetido deja el mismo estado.
1. **Postgres pasa a ser una dependencia dura de enviar mensajes.** Si no responde, se rechaza el envío (`503 MESSAGES_UNAVAILABLE`) y `/readyz` responde 503. Mongo y RabbitMQ siguen teniendo su propio tratamiento.
1. **Un edit o un borrado puede anotarse y después descubrir que el mensaje ya no existe** (borrado en simultáneo). Se publica un evento sobre algo que ya no está; los clientes lo ignoran. Es una carrera muy rara.
1. **El poller consulta cada segundo** aunque no haya nada, además de despertarse al anotar. Es una consulta barata con índice parcial sobre las pendientes.
1. **Las filas crecen sin límite** (decisión de auditoría). El contenido ya está vaciado y la tabla es angosta; el plazo de retención queda como decisión abierta si el volumen lo exige.

### Qué se descubrió probándolo (y quedó corregido)

- `Postgrex.transaction` **lanza una excepción** si no hay conexión, en lugar de devolver un error: tumbaba al poller y al canal que enviaba. Ahora siempre devuelve `{:error, _}`.
- La cola de cada instancia en `messaging.broadcast` era efímera (`exclusive`): si RabbitMQ se reiniciaba y el evento se publicaba antes de que la instancia recreara su cola, el fanout lo **descartaba**. Ahora es **durable por instancia** (`messaging.broadcast.<id>`, vence a los 10 minutos sin consumidor y descarta mensajes de más de 5): lo publicado mientras la instancia estuvo ausente la espera.

## 5. Lo que no cubre

- Cola de eventos fallidos (DLQ) con límite de reintentos y un procedimiento para reprocesarlos.
- Retención y archivado de `outbox_events` (hoy: nunca se borra).
- Cola de eventos para otros servicios: el outbox cubre solo lo que `messaging` avisa a sus propias instancias.
- La entrega al cliente final sigue siendo de mejor esfuerzo: un cliente desconectado se pone al día con el historial y `changes_since`.

## 6. Seguimiento

- Prueba con más de una instancia de `messaging` **Hecha (2026-10-13)**: ver la última fila de la sección 7.
- DLQ y procedimiento de reproceso.
- Decidir el plazo de retención de las filas ya publicadas, con datos reales de volumen.

## 7. Verificación (2026-10-13)

- **El evento se anota antes de tocar Mongo, y si no se puede anotar no se toca Mongo**: `messaging/test/messaging/chat/outbox_flow_test.exs`
- **Mongo caído después de anotar: el mensaje se acepta y se completa después**: `chat_test.exs` ("if only Mongo fails…") y prueba en vivo (sección 4 del guion)
- **Dos pollers nunca toman la misma fila; una instancia muerta deja sus filas pendientes; el orden por mensaje**: `messaging/test/messaging/outbox/store/postgres_test.exs` (Postgres real)
- **Publicado = contenido vaciado y fila conservada**: mismo archivo, y en vivo (el texto no aparece en ninguna columna)
- **RabbitMQ caído: se aceptan mensajes, quedan pendientes y salen en orden al volver**: en vivo con el stack completo detrás de Kong
- **Postgres caído: `503 MESSAGES_UNAVAILABLE`, nada queda a medias, `/readyz` 503**: en vivo
- **Un fallo de Postgres devuelve un error, no una excepción**: `postgres_test.exs` ("with a database that is down")
- **La cola durable espera a una instancia ausente**: `broadcast_test.exs` (RabbitMQ real)
- **Migraciones en el schema `messaging` con su propia tabla de versiones**: `make migrate` contra Postgres con `DATABASE_SCHEMA=messaging`
- **Con dos instancias vivas: 40 mensajes concurrentes sin pérdidas ni duplicados, cada fila publicada una vez, una fila bloqueada no frena a las demás, RabbitMQ caído y una instancia que muere**: `infrastructure/scripts/multi-instance-check.mjs`: 53 comprobaciones, 3 corridas seguidas sin fallas. Con dos instancias y ráfagas simultáneas el orden de llegada entre mensajes distintos puede variar (solo está garantizado por mensaje): ordenados por `id` quedan siempre en orden de envío. Con una instancia el orden de llegada es el de envío

Código: `messaging/lib/messaging/outbox*`, `lib/messaging/postgres.ex`, `lib/messaging/events/broadcast_publisher.ex`, `lib/messaging/events/broadcast_consumer.ex`, `migrations/`; `infrastructure/docker-compose.yml`; `.github/workflows/ci.yml` (job `migrate`).
