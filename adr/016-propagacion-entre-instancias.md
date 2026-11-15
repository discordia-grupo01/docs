# ADR-016: Propagación en tiempo real entre instancias de messaging con un fanout de RabbitMQ

**Estado:** Aceptada (decisión tomada al diseñar `messaging`; documentada y verificada el 2026-10-13)  
**Fecha**: 2026-10-13  
**Servicios**: `messaging`, RabbitMQ (`infrastructure`), Kong (`gateway`)  
**Decidida por**: Facundo Madotta (diseño e implementación)  
**Pedida por**: Revisión semanal del 2026-10-09: "falta el ADR de propagación y la prueba con varias instancias"  
**Relacionadas**: ADR-018 (outbox: de dónde salen los eventos que se propagan), ADR-019 (operación con más de una instancia)

## 1. Contexto

Los clientes se conectan a `messaging` por WebSocket. Cada conexión vive en **una** instancia. Cuando alguien envía, edita o borra un mensaje, hay que avisar a todos los conectados al canal, y los conectados pueden estar en **otra** instancia que la de quien envió. Lo mismo pasa con los DM, las menciones, las reacciones y el aviso `access_revoked` (alguien perdió el acceso a un canal).

Lo que se necesita de la propagación:

1. **Todas las instancias reciben todo**: cada una entrega a sus propias conexiones.
1. **No se pierden avisos por una ausencia corta**: si RabbitMQ o una instancia se reinicia unos segundos, lo publicado mientras tanto tiene que esperar.
1. **Sin infraestructura nueva si se puede evitar**: el proyecto ya tiene RabbitMQ para los eventos de dominio entre `servers`, `identity` y `messaging`.
1. **Sin estado en memoria que importe entre instancias** (regla del proyecto).
1. **Una sola instancia en producción**: la cátedra pidió verificar que funciona con más de una, pero mantener una. El diseño tiene que soportar escalar, aunque hoy no se escale.

## 2. Decisión

Un exchange **fanout** propio, `messaging.broadcast`, separado de `discordia.events`:

```
cualquier instancia ──▶ outbox ──▶ messaging.broadcast (fanout) ──▶ cola durable de cada instancia
```

```
                                                                         │
```

```
                                  BroadcastConsumer ──▶ Phoenix.PubSub local ──▶ canales WebSocket de esa instancia
```

- **Una cola por instancia**, durable: `messaging.broadcast.<id>`. Vence a los **10 minutos** sin consumidor y descarta mensajes de más de **5 minutos**. Así, lo publicado mientras una instancia se reconecta la espera, pero una instancia que ya no existe no acumula mensajes para siempre.
- **Confirmación del broker** (publisher confirms): un evento solo se marca como publicado cuando RabbitMQ lo confirmó (ver ADR-018).
- **Exchange separado de `discordia.events`**: ese es el contrato de eventos de dominio entre servicios, con otros consumidores y otro ciclo de cambios. La propagación entre instancias de `messaging` es un detalle interno de `messaging`; mezclarlas acoplaría a los demás servicios con él.
- **Entrega local con `Phoenix.PubSub`**: el consumidor de cada instancia reenvía lo recibido al tópico local (`channel:<id>`, `user:<id>`), y de ahí llega a las conexiones. No hay lógica de ruteo propia.

Las colas de los eventos de `servers` e `identity` (canales, roles, miembros, perfiles) son **otra** cosa: una cola compartida, `messaging.channel_lifecycle`, donde las instancias compiten y cada evento lo procesa una sola.

## 3. Alternativas descartadas

- **`Phoenix.PubSub` distribuido (nodos Erlang en cluster)**: Es lo que Phoenix trae por defecto y no necesita broker, pero exige conectar los nodos entre sí (cookie, puertos, descubrimiento) a través de las VMs. Si hay una partición de red, los avisos se pierden sin rastro, y una instancia que se reinicia no recibe nada de lo que pasó mientras estuvo caída. Ata además el despliegue al cluster de Erlang.
- **Redis pub/sub (`phoenix_pubsub_redis`)**: Es un servicio nuevo que operar. Su pub/sub **no guarda nada**: si una instancia no está suscripta en ese momento, el mensaje se pierde. Redis Streams sí guarda, pero implicaría otra pieza más sin que aporte algo que RabbitMQ no tenga ya.
- **NATS**: Liviano y rápido, pero el modo básico también es "como mucho una vez" y sin persistencia; para tenerla hay que usar JetStream. Sería, de nuevo, un servicio nuevo que nadie del equipo opera.
- **Kafka**: Log persistente con repetición, muy potente, pero pensado para volúmenes y cantidades de consumidores mucho mayores. Operarlo (o contratarlo) es desproporcionado para propagar avisos entre una o pocas instancias, y las instancias efímeras encajan mal con grupos de consumidores.
- **Postgres `LISTEN/NOTIFY`**: Ya hay un Postgres por el outbox, pero `NOTIFY` no guarda nada (una instancia desconectada no recibe lo que se emitió) y el contenido está limitado a unos 8 KB.
- **Change streams de Mongo**: Evitarían el broker, pero exigen que Mongo corra como replica set (en local es un nodo suelto) y atan el tiempo real a la base de datos.
- **No propagar (una sola instancia)**: Es lo que pasa hoy en producción, pero impide escalar y la cátedra pidió verificar que funciona con más de una.

**Por qué RabbitMQ**: ya está en el proyecto (lo usan `servers` e `identity`), sus **colas durables** dan lo que Redis pub/sub y NATS básico no dan (esperar a quien no está), y las confirmaciones del broker encajan con el outbox. No agrega ninguna pieza nueva.

## 4. Consecuencias

### Positivas

- Escalar `messaging` es levantar otra instancia: crea su cola y empieza a recibir.
- Un reinicio corto de RabbitMQ o de una instancia no pierde avisos (hasta 5 minutos).
- No hay estado compartido en memoria: todo lo que importa vive en Mongo, Postgres y RabbitMQ.

### Negativas y riesgos conocidos

1. **Entrega "al menos una vez"**: puede llegar un evento repetido (por ejemplo, si el proceso muere entre publicar y marcar en el outbox). Los clientes deduplican por el `id` del mensaje.
1. **Orden entre mensajes distintos con más de un poller**: con dos instancias y ráfagas simultáneas, dos mensajes pueden llegar en otro orden (por mensaje sí se respeta). Medido: unas 3 a 5 inversiones por cada 20 mensajes enviados a la vez; con mensajes de a uno, o con una sola instancia, **ninguna**. Ordenados por `id` (UUIDv7) quedan siempre en el orden en que se enviaron, así que el cliente tiene que ordenar por `id`.
1. **Cada instancia recibe todo el tráfico**, aunque no tenga conexiones interesadas: el costo crece con instancias × mensajes. Con una instancia es nulo. Si hiciera falta, la mejora es pasar a un exchange `topic` con una clave por servidor.
1. **Una instancia ausente más de 10 minutos pierde sus avisos pendientes** (la cola vence), y los que tienen más de 5 minutos se descartan. Una instancia que se **reinicia como proceso nuevo** crea una cola con otro nombre, así que tampoco recibe lo que se publicó en su ausencia (ver ADR-019). Los clientes se ponen al día con el historial (`last_message_id`) y con `changes_since`, que es el mecanismo de reconexión de todos modos.
1. **RabbitMQ pasa a ser parte del tiempo real**: si cae, los mensajes igual se aceptan y quedan en el outbox, y salen al volver (ADR-018), pero en vivo no llega nada hasta entonces.

### Qué se descubrió probándolo (y quedó corregido)

- La cola por instancia era **efímera** (`exclusive`): si RabbitMQ se reiniciaba y el evento se publicaba antes de que la instancia recreara su cola, el fanout lo descartaba. Por eso hoy es durable y con vencimiento.
- Con dos instancias detrás de Kong, cuando una moría, Kong seguía mandándole una parte del tráfico y cada intento se colgaba 60 s (el `connect_timeout` por defecto) antes de reintentar en la viva. El ticket del WebSocket dura 30 s, así que el cliente no podía reconectar. Ahora `messaging-service` tiene `connect_timeout: 3000` y reconectar tarda unos 3 s.

## 5. Lo que no cubre

- Escalar en producción: se mantiene **una** instancia (indicación de la cátedra). `MESSAGING_UPSTREAM_URL` sigue siendo una sola dirección.
- Entrega garantizada al cliente final: un cliente desconectado se pone al día por el historial, no por esta propagación.
- Filtrar por servidor en el broker (ver el riesgo 3).

## 6. Seguimiento

- Si algún día se escala: apuntar `MESSAGING_UPSTREAM_URL` a un nombre que resuelva a todas las instancias (o definir un `upstream` de Kong con un `target` por instancia) y evaluar el exchange `topic`.
- Confirmar que el web-client y el app-mobile ordenan por `id` y deduplican por `id`.

## 7. Verificación (2026-10-13)

- **El camino real publicador → RabbitMQ → consumidor → PubSub local, con confirmación y cola durable por instancia**: `messaging/test/messaging/events/broadcast_test.exs` (RabbitMQ real)
- **La cola durable espera a una instancia ausente**: mismo archivo
- **Todas las instancias reciben todo y entregan exactamente una vez por socket (enviar, editar, reaccionar, borrar, DM, mención)**: `infrastructure/scripts/multi-instance-check.mjs`, casos 1 a 3 y 9
- **Tickets del socket: sirven en cualquier instancia y una sola vez**: mismo script, caso 4
- **40 mensajes concurrentes desde dos instancias, sin pérdidas ni duplicados**: mismo script, caso 5
- **RabbitMQ caído con las dos instancias escribiendo: nada se pierde ni se duplica**: mismo script, caso 7
- **`access_revoked` por expulsión, baneo, salida, canal borrado y servidor borrado llega a la conexión en la instancia que sea; cada evento de `servers` lo procesa una sola instancia**: mismo script, casos 8 y 8b (52 eventos, todos con `attempts = 1`)
- **Un cambio de permisos en `servers` se ve en las dos instancias**: mismo script, caso 10
- **Kong reparte el tráfico y una instancia muerta no deja a los clientes sin reconectar**: mismo script, casos 11 y 12
- **Orden de llegada: una instancia = orden de envío; dos instancias, ráfagas = ordenable por `id`**: mismo script, casos 5 y 13

Resultado: **53 comprobaciones, 3 corridas seguidas sin fallas.** Se corre con `docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.multi.yml up -d --build` y `node scripts/multi-instance-check.mjs` desde `infrastructure/`.

Código: `messaging/lib/messaging/events/broadcast_publisher.ex`, `broadcast_consumer.ex`, `lib/messaging/outbox/broadcaster.ex`; `infrastructure/docker-compose.multi.yml`; `gateway/kong/kong.yml.template`.
