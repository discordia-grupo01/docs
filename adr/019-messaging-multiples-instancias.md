# ADR-019: messaging con más de una instancia: estado compartido, reparto en Kong y una sola instancia en producción

**Estado:** Aceptada
**Fecha:** 2026-10-23
**Servicios:** `messaging`, `gateway` (Kong), `infrastructure`
**Relacionadas:** ADR-016 (propagación en tiempo real), ADR-017 (réplica local), ADR-018 (outbox)

## Contexto

`messaging` corre hoy como una sola instancia, un contenedor en la VM de Oracle. La cátedra nos pidió dos cosas a la vez: demostrar que el servicio funciona con más de una instancia, y no escalar el despliegue, o sea mantener solo una en producción.

Para que lo primero sea cierto, ninguna instancia puede guardar en su memoria algo que las demás necesiten. Y hay una consecuencia propia del tiempo real: un usuario conectado por WebSocket vive en una instancia concreta, y los demás usuarios de su canal pueden estar en otra. Este ADR cuenta cómo se comporta el sistema con dos instancias, qué decisiones lo hacen posible y dónde están sus límites. La propagación entre instancias en sí, con el fanout de RabbitMQ, está en el ADR-016.

## Decisión

Lo primero fue sacar de la memoria de cada instancia todo lo que importa. Los mensajes, los mensajes directos, los bloqueos, las menciones y los metadatos de adjuntos viven en Mongo y todas las instancias leen y escriben lo mismo. La réplica de permisos, roles y usuarios (ADR-017) también está en Mongo y la alimentan los eventos. Los tickets del WebSocket están en Mongo: uno pedido a una instancia se canjea en cualquiera, una sola vez y dentro de 30 segundos. Los eventos pendientes de publicar están en el outbox de Postgres (ADR-018), y cada poller toma sus filas con `FOR UPDATE SKIP LOCKED`, de modo que dos no toman la misma. Los avisos en vivo pasan por el fanout `messaging.broadcast`, con una cola por instancia, y los eventos de `servers` e `identity` por la cola compartida `messaging.channel_lifecycle`, donde las instancias compiten y cada evento lo procesa una sola. Lo único que cada instancia tiene para sí es la lista de sus propias conexiones WebSocket, que por definición no se comparte.

El reparto lo hace Kong. Las instancias se anuncian bajo un mismo nombre (en el stack local, `messaging-pool`, un alias de red que comparten los contenedores), Kong lo resuelve por DNS y alterna entre las direcciones petición por petición. No hay afinidad de sesión: ninguna petición pertenece a una instancia, y solo la conexión WebSocket, una vez abierta, se queda en la que la aceptó. El cliente no elige instancia ni la conoce. Además fijamos `connect_timeout: 3000` en `messaging-service`; con el valor por defecto de Kong, 60 segundos, cuando una instancia moría Kong le seguía mandando una parte del tráfico y cada intento esperaba un minuto antes de probar con la otra.

Si una instancia cae, la reconexión es cosa del cliente. Detecta el cierre, pide un ticket nuevo por Kong, abre el WebSocket otra vez por la misma URL, que Kong manda a la instancia viva, y se une al canal con `last_message_id` para recibir en `missed_messages` lo que se envió mientras estuvo desconectado. El servidor no mueve conexiones ni mantiene sesiones.

El orden queda garantizado por mensaje: un mensaje y sus ediciones y borrado salen en orden, porque el outbox no publica dos eventos del mismo mensaje a la vez. Entre mensajes distintos, con más de un poller, el orden de llegada puede variar si se mandan en ráfaga. Los ids son UUIDv7, ordenables por tiempo, así que los clientes ordenan por `id` y no por orden de llegada.

En producción sigue habiendo una sola instancia. `MESSAGING_UPSTREAM_URL` en el gateway es una única dirección fija, la IP de Tailscale de la VM de `messaging`, y la segunda instancia y el alias `messaging-pool` existen solo en `infrastructure/docker-compose.multi.yml`, que usamos para probar y para la demo. Si algún día hubiera que escalar, alcanzaría con apuntar esa variable a un nombre que resuelva a todas las instancias, o con definir en Kong un `upstream` con un `target` por instancia.

## Alternativas descartadas

Pensamos en afinidad de sesión en Kong, por ejemplo con un hash por usuario o por canal. Mantendría a cada usuario en su instancia, pero no hace falta porque el estado es compartido y la reconexión recupera lo perdido, y además exige un `upstream` explícito y no resuelve la caída de una instancia.

Tampoco quisimos dividir el tráfico con una instancia por canal o por servidor. Resolvería el orden, pero obliga a mantener un directorio de qué instancia atiende qué, con un punto de coordinación, y es mucho más de lo que necesita una sola instancia en producción.

Guardar sesiones o conexiones en una memoria compartida como Redis rompía la regla del proyecto de no tener estado en memoria entre instancias y sumaba una pieza nueva. Escalar en producción quedó descartado por pedido expreso de la cátedra. Y un orquestador como Kubernetes o Swarm es desproporcionado para una demostración con dos contenedores.

## Consecuencias

Sumar instancias no requiere tocar `messaging`: se levanta otra con el mismo nombre de red. Una instancia que cae no pierde mensajes, porque están en el outbox y en Mongo, y los clientes se ponen al día solos. Lo probamos con el web-client real y con un cliente de terminal, y también con una prueba automática de 53 comprobaciones que corrió varias veces seguidas sin fallas.

Hay límites que conviene tener claros:

- Una instancia que se reinicia crea una cola nueva con otro nombre, así que no recibe lo que se publicó mientras estuvo caída, y la cola vieja vence a los 10 minutos. Los clientes lo recuperan por el historial. Es distinto de un corte de RabbitMQ con el proceso vivo, donde la cola conserva su nombre y espera.
- Con más de una instancia y mensajes en ráfaga medimos unas 3 a 5 inversiones cada 20; con una sola instancia, o con mensajes de a uno, ninguna.
- Kong guarda las direcciones que resolvió, así que al caer una instancia puede seguir mandándole tráfico hasta que expire su caché de DNS. El `connect_timeout` de 3 segundos acota el costo a unos 3 segundos de reconexión, y tras cambiar la configuración de Kong hay que reiniciarlo.
- La conexión se cierra a los 60 segundos sin actividad. El cliente de Phoenix manda latidos solo, pero uno hecho a mano, como Postman o un script, tiene que mandarlos.
- El reparto depende del patrón de peticiones. Un cliente que hace un número par de peticiones por conexión puede caer siempre en la misma instancia. Con las tres que hace el cliente de la demo (ticket, socket e historial) los clientes consecutivos se alternan; no medimos el patrón exacto del web-client.
- Un usuario recién registrado no existe para `messaging` hasta que llega su evento de perfil, unos segundos, como se explica en el ADR-017.

Probándolo encontramos tres cosas que quedaron resueltas. Con el `connect_timeout` por defecto, reconectar después de la caída de una instancia fallaba porque el ticket de 30 segundos vencía durante la espera. Un cliente sin latidos perdía la conexión a los 60 segundos y parecía una caída de instancia. Y como ticket y socket son dos peticiones seguidas, con dos instancias varios clientes consecutivos caían siempre en la misma, lo cual no es un error del sistema.

Quedan fuera de esta decisión escalar en producción, mover conexiones ya abiertas de una instancia a otra, y usar más de dos instancias: la prueba usa dos, aunque el diseño no depende del número.
