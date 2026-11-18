# ADR-016: Propagación en tiempo real entre instancias de messaging con un fanout de RabbitMQ

**Estado:** Aceptada
**Fecha:** 2026-10-13
**Servicios:** `messaging`, RabbitMQ (`infrastructure`), Kong (`gateway`)
**Relacionadas:** ADR-018 (outbox), ADR-019 (más de una instancia)

## Contexto

Los clientes se conectan a `messaging` por WebSocket y cada conexión vive en una sola instancia. Cuando alguien manda, edita o borra un mensaje hay que avisar a todos los conectados al canal, y puede que estén en otra instancia distinta de la que recibió el pedido. Pasa lo mismo con los mensajes directos, las menciones, las reacciones y el aviso de que alguien perdió el acceso a un canal.

Teníamos cuatro condiciones. Todas las instancias tienen que recibir todo para entregarlo a sus propias conexiones. Un corte corto de RabbitMQ o de una instancia no puede hacer perder avisos. No queríamos sumar infraestructura nueva si RabbitMQ ya alcanzaba. Y no podíamos depender de estado en memoria compartido entre instancias, que es una regla del proyecto. En producción corre una sola instancia, pero la cátedra pidió que el diseño funcione con varias y lo verificamos así.

## Decisión

`messaging` publica cada aviso en un exchange propio de tipo fanout, `messaging.broadcast`, y cada instancia tiene su propia cola durable (`messaging.broadcast.<id>`) conectada a él. El consumidor de cada instancia reenvía lo que recibe a `Phoenix.PubSub` local, y de ahí llega a los canales WebSocket de esa instancia. Los avisos salen del outbox (ADR-018) y un evento se marca como publicado recién cuando RabbitMQ lo confirma.

La cola de cada instancia vence a los 10 minutos sin consumidor y descarta mensajes de más de 5 minutos. Así, lo que se publica mientras una instancia se reconecta la espera, pero una instancia que ya no existe no acumula mensajes para siempre.

Usamos un exchange separado de `discordia.events` a propósito. Ese es el contrato de eventos entre servicios, con otros consumidores y otro ritmo de cambios, y la propagación entre instancias es un detalle interno de `messaging` que no tiene por qué acoplar a los demás.

Los eventos de `servers` e `identity` (canales, roles, miembros, perfiles) son otra cosa. Van por una cola compartida, `messaging.channel_lifecycle`, donde las instancias compiten y cada evento lo procesa una sola.

## Alternativas descartadas

- **`Phoenix.PubSub` distribuido entre nodos Erlang.** Es lo que Phoenix trae de fábrica, pero obliga a conectar los nodos entre sí a través de las VMs. Si la red se parte, los avisos se pierden sin dejar rastro, y una instancia que se reinicia no se entera de lo que pasó mientras estuvo caída.
- **Redis pub/sub.** Habría que operar un servicio nuevo y su pub/sub no guarda nada: si una instancia no está suscripta en ese momento, pierde el mensaje.
- **NATS.** El modo básico tampoco guarda mensajes, y para tenerlo hace falta JetStream. Seguiría siendo un servicio nuevo que nadie del equipo opera.
- **Kafka.** Es muy potente, pero desproporcionado para avisar entre una o pocas instancias, y las instancias efímeras encajan mal con los grupos de consumidores.
- **`LISTEN/NOTIFY` de Postgres.** No guarda nada para quien está desconectado y limita el contenido a unos 8 KB.
- **Change streams de Mongo.** Exigen que Mongo corra como replica set, algo que en local no pasa, y atan el tiempo real a la base de datos.

Nos quedamos con RabbitMQ porque ya estaba en el proyecto, sus colas durables resuelven el caso de la instancia ausente que Redis y NATS básico no resuelven, y las confirmaciones del broker encajan con el outbox.

## Consecuencias

Lo bueno es que escalar `messaging` pasa a ser levantar otra instancia: crea su cola y empieza a recibir. Un reinicio corto de RabbitMQ o de una instancia no pierde avisos, siempre que dure menos de 5 minutos, y no hay estado compartido en memoria.

También hay costos, y conviene tenerlos presentes. La entrega es "al menos una vez", así que un aviso puede llegar repetido, por ejemplo si el proceso se cae entre publicar y marcar el evento en el outbox; los clientes lo resuelven deduplicando por el `id` del mensaje. Con más de una instancia publicando en ráfaga, dos mensajes distintos pueden llegar en otro orden: lo medimos y salen unas 3 a 5 inversiones cada 20 mensajes enviados a la vez, y ninguna si se mandan de a uno o con una sola instancia. Como el `id` es un UUIDv7, ordenar por `id` devuelve siempre el orden de envío, y eso es lo que tienen que hacer los clientes.

Otro costo es que cada instancia recibe todo el tráfico aunque no tenga conexiones interesadas, de modo que el gasto crece con instancias por mensajes. Con una sola instancia es cero, y si algún día molesta la salida es un exchange `topic` con una clave por servidor. Además, una instancia que falta más de 10 minutos pierde sus avisos pendientes, y una que arranca como proceso nuevo crea una cola con otro nombre; en los dos casos el cliente se pone al día con el historial y con `changes_since`, que es como se reconecta igual. Por último, RabbitMQ pasa a ser parte del tiempo real: si cae, los mensajes se siguen aceptando y quedan en el outbox, pero en vivo no llega nada hasta que vuelva.

Probándolo nos encontramos con dos problemas que ya corregimos. La cola de cada instancia era efímera, y si RabbitMQ se reiniciaba antes de que la instancia la recreara, el fanout tiraba el aviso; por eso ahora es durable y con vencimiento. Y con dos instancias detrás de Kong, cuando una se caía cada intento hacia ella se quedaba colgado 60 segundos antes de pasar a la que estaba viva, más de lo que dura el ticket del WebSocket, así que el cliente no lograba reconectar. Con `connect_timeout: 3000` reconectar tarda unos 3 segundos.

Dejamos afuera, a propósito, escalar `messaging` en producción (sigue habiendo una sola instancia, como pidió la cátedra) y garantizar la entrega al cliente final, que se pone al día por el historial y no por esta propagación.
