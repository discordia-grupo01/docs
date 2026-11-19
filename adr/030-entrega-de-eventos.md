# ADR-030: Entrega confiable de eventos: outbox, reintentos con cola de eventos muertos e idempotencia

**Estado:** Aceptada
**Fecha:** 2026-11-07
**Servicios:** todos los que publican o consumen eventos (`servers`, `identify-service`, `admin`, `billing`, `metrics`, `messaging`, `notifications`, `voice-sfu`)
**Relacionadas:** ADR-007 (pub/sub), ADR-017 (réplica local), ADR-018 (outbox de `messaging`), ADR-020 (no leídos por eventos), ADR-037 (circuit breaker)

## Contexto

Como los servicios se hablan por eventos (ADR-007), la plataforma funciona bien solo si un evento válido llega y se aplica una vez, aunque lo normal sea que llegue más de una o fuera de orden. En la práctica pueden fallar tres cosas distintas: que un servicio no logre publicar porque RabbitMQ no responde en ese momento, que un consumidor no pueda procesar un evento válido porque su base está caída, y que un evento llegue roto y no se pueda procesar nunca.

El tercer caso nos preocupaba especialmente. Antes de esta decisión, un evento que fallaba siempre se devolvía a la cola con `nack` y reencolado sin límite: se reintentaba para siempre, frenaba a todos los que venían detrás y no dejaba más rastro que el log. En `voice-sfu` y en `metrics` ni siquiera esperaba entre un intento y el siguiente. El corrector nos preguntó qué pasa con un evento que nunca se procesa, y la respuesta era "nada bueno".

## Decisión

Resolvimos el problema en tres capas, cada una con su propio mecanismo.

**Publicar sin perder eventos: outbox transaccional.** El servicio escribe el evento en una tabla `outbox_events`, dentro de la misma transacción que el cambio de negocio. Un poller lo publica después, con confirmación del broker, y recién entonces lo marca como publicado. Si RabbitMQ no está, el evento espera en la base. Es el patrón que `servers`, `identify-service`, `admin` y `billing` ya usaban y que `messaging` adoptó en el ADR-018. `metrics` publica directo, sin outbox, porque sus eventos no cambian el estado de nadie.

**Consumir sin quedar atascado: reintentos y cola de eventos muertos.** La política es igual en todos los servicios que consumen colas. Un evento se intenta hasta 5 veces, esperando 1, 2, 4 y 8 segundos entre intentos, con una variación de más o menos 20% para que varias instancias no reintenten a la vez. Si falla el quinto intento, se publica, con confirmación, a una cola `<cola>.dlq` del exchange `discordia.dlx`, y recién después se confirma el original. Si publicar en la cola de eventos muertos falla, el original no se confirma y sigue en su cola. El mensaje apartado conserva el cuerpo y lleva en sus cabeceras la cola y la routing key de origen, el `event_id`, los intentos y la fecha.

Cada consumidor decide qué es un fallo transitorio y qué es permanente. Si la base, LiveKit o los sockets no responden, es transitorio y se reintenta. Si el JSON está roto, faltan campos, la firma HMAC es inválida o la routing key es desconocida, es permanente: se confirma y se descarta sin reintentar, dejando constancia en el log o en la auditoría. Un evento repetido o más viejo que lo ya guardado no es un fallo y se ignora. Cualquier error que no esté en la lista de permanentes se trata como transitorio, de modo que un error nuevo e inesperado nunca se pierde: termina en la cola de eventos muertos para que lo revise una persona.

**Aplicar sin duplicar efectos: idempotencia.** Los eventos que cambian datos llevan una foto completa de la entidad y una fecha o versión, y el consumidor aplica solo si es más nuevo que lo que ya tiene (ADR-017). Así, uno repetido no cambia nada y uno atrasado no pisa a uno nuevo. Los borrados dejan una lápida con vencimiento para que una foto vieja no resucite lo borrado.

## Alternativas descartadas

- **Colas de tipo quorum con `x-dead-letter-exchange` y límite de entregas nativo.** Es la solución más limpia, pero RabbitMQ no permite cambiar los argumentos de una cola que ya existe, así que habríamos tenido que borrar y recrear las colas en producción. Contamos los intentos en la aplicación para no tocarlas.
- **Seguir con el reencolado infinito.** Es lo que teníamos, y frena la cola entera por un único evento defectuoso.
- **Descartar todo lo que falle.** Evita atascos, pero un evento válido que falla por una caída de la base se perdería para siempre.
- **Un inbox en la base para saber qué evento ya se procesó.** Daría una deduplicación exacta, pero suma una escritura por evento en cada consumidor; la idempotencia por versión o fecha alcanza para nuestros casos.
- **Un orquestador de colas de reintento con esperas en RabbitMQ (colas con TTL).** Evita mantener la cuenta en la aplicación, pero multiplica las colas y complica la operación.

## Consecuencias

Un RabbitMQ caído o reiniciado no pierde eventos, un evento roto deja de frenar a los demás, y un fallo transitorio se recupera solo cuando vuelve lo que faltaba. Tenemos además una cola de eventos muertos por cada cola de consumo, con 18 colas hoy en producción, y un procedimiento escrito para revisar un evento apartado y volver a inyectarlo (`reintentos-y-dlq.md`).

Hay límites que conviene saber. La cuenta de intentos está en memoria del consumidor, así que si el servicio se reinicia el evento vuelve a tener 5 intentos, y con varias instancias de un mismo consumidor puede sumar más de 5 antes de apartarse. Por eso la entrega es "al menos una vez" y todos los consumidores tienen que tolerar repetidos. El motivo de cada fallo queda en el log y no en las cabeceras del mensaje apartado. No hay todavía una alerta cuando una cola de eventos muertos tiene mensajes, y se revisan a mano. Y las filas del outbox no se borran, decisión que hay que revisar si el volumen crece. Las colas efímeras de cada instancia, como `messaging.broadcast.<id>`, quedan afuera a propósito: confirman siempre y perder un aviso en vivo se compensa leyendo el historial.
