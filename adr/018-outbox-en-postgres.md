# ADR-018: Outbox transaccional de messaging en Postgres, con los mensajes en Mongo

**Estado:** Aceptada
**Fecha:** 2026-10-13
**Servicios:** `messaging`, `infrastructure`, Supabase (Postgres de producción)
**Relacionadas:** ADR-016 (propagación entre instancias), ADR-030 (entrega de eventos)

## Contexto

Cuando alguien manda un mensaje, `messaging` hace dos cosas en sistemas distintos: guarda el mensaje en Mongo y avisa a las demás instancias por RabbitMQ para que lo entreguen a sus clientes. No hay forma de hacer las dos de manera atómica, y fallaba de dos maneras. Si el proceso se moría, o RabbitMQ no contestaba, entre una cosa y la otra, el aviso se perdía: el mensaje existía pero nadie conectado lo recibía. Y como el código esperaba que la publicación saliera bien, un RabbitMQ caído terminaba cerrando el canal de quien estaba enviando. Lo mismo pasaba con ediciones, borrados, mensajes directos, menciones, reacciones y avisos de acceso revocado.

`servers` e `identify-service` ya resolvían este problema con un outbox transaccional en Postgres. Los mensajes de `messaging` tienen que seguir en Mongo porque ese es su modelo de datos, así que el outbox necesitaba un Postgres aparte. La revisión semanal del 9 de octubre pidió hacerlo "como servers".

## Decisión

Cada vez que hay algo para avisar, el evento se anota en Postgres antes de tocar Mongo. El flujo es: se inserta la fila en `outbox_events` (si eso falla se responde 503 y no se toca Mongo), se escribe en Mongo, y se responde OK. Después un poller completa lo que falte, publica en RabbitMQ, espera la confirmación del broker y recién ahí marca la fila como publicada.

Cada fila lleva lo necesario para terminar el trabajo si la instancia muere en el medio: el evento (`payload`) y una instrucción (`apply`) para dejar Mongo en el estado correcto, que puede ser insertar, actualizar o borrar un mensaje. Esas escrituras son idempotentes, así que se pueden repetir sin efecto. Si Mongo falla después de anotar, el pedido no se rechaza: el mensaje ya quedó aceptado de forma durable y el poller lo completa. Sin outbox habría que hacer lo contrario.

El poller corre en cada instancia, una vez por segundo y además apenas se anota un evento, para no perder latencia. En una transacción toma un lote con `FOR UPDATE SKIP LOCKED`, de modo que dos instancias nunca toman la misma fila, y si una muere a mitad de lote su transacción se revierte y las filas quedan para otra. Una fila no se toma mientras exista otra anterior sin publicar del mismo mensaje, así que la creación, las ediciones y el borrado de un mismo mensaje salen siempre en orden. La publicación usa confirmaciones del broker y pone el id del evento como `message_id` de RabbitMQ.

Las filas no se borran nunca, para poder responder qué pasó con cada evento. Al publicarse se vacían `payload` y `apply`, de modo que el texto de los mensajes no queda en Postgres; permanecen el tipo de evento, los ids, las fechas, los intentos y el último error. Si RabbitMQ está caído o no confirma, se reintenta sin límite y sin gastar intentos, porque no es culpa de la fila. Una fila que no se puede interpretar sí cuenta un intento, y a los 10 se deja de intentar y queda a la vista en la tabla.

En producción el outbox vive en el schema `messaging` de la base compartida de Supabase, a través del Session pooler (ver ADR-004). Las migraciones se aplican desde el CI/CD con `golang-migrate`: un job `migrate` corre antes del deploy y, si falla, no se despliega. En local y en el CI usamos un Postgres propio.

## Alternativas descartadas

- **Outbox en Mongo, junto con los mensajes.** Sin transacciones entre colecciones no ganamos atomicidad respecto de hoy, y se había pedido que fuera como en `servers`, con Postgres.
- **Escribir en Mongo y después anotar en el outbox.** Deja una ventana, con el proceso muerto entre las dos escrituras, en la que el mensaje existe y el evento no. Anotando primero, el peor caso es un evento de más, nunca uno de menos.
- **Publicar directo y reintentar en memoria.** Se pierde si la instancia muere, y una regla del proyecto es no guardar nada en memoria.
- **Change streams de Mongo.** Exigen replica set, atan el aviso al driver de Mongo y no cubren eventos que no son documentos, como el acceso revocado.
- **Un inbox en Postgres para evitar duplicados.** Sería una fila por evento y por instancia en el camino del tiempo real. El consumo ya tolera repetidos: el cliente deduplica por `id` y las fotos de permisos viejas se descartan.

## Consecuencias

Con esto, un RabbitMQ que se cae o se reinicia ya no pierde eventos ni cierra el canal de quien envía, y una instancia que muere después de anotar no deja mensajes a medio guardar. Además queda un registro permanente de cada aviso, con cuándo se anotó, cuándo salió, cuántos intentos llevó y por qué falló, y varias instancias pueden correr el poller a la vez sin coordinarse.

Lo que asumimos a cambio es que la entrega sea "al menos una vez". Si el proceso muere entre publicar y marcar la fila, el evento sale dos veces con el mismo `id`. No lo evitamos en el servidor porque no queremos estado en memoria; los clientes deduplican por el `id` del mensaje y las repeticiones son inofensivas, porque repetir un mensaje, una edición o un borrado deja el mismo estado.

Postgres pasa a ser una dependencia dura de enviar mensajes: si no responde, se rechaza el envío con `503 MESSAGES_UNAVAILABLE` y `/readyz` devuelve 503. También puede pasar que se anote la edición o el borrado de un mensaje que otro borró al mismo tiempo; se publica un evento sobre algo que ya no existe y los clientes lo ignoran, una carrera muy rara. El poller consulta cada segundo aunque no haya nada, pero con un índice parcial sobre las pendientes es barato. Y las filas crecen sin límite, decisión tomada por la auditoría; el contenido ya está vaciado y la tabla es angosta, y el plazo de retención queda abierto hasta que el volumen real lo pida.

Probándolo salieron dos cosas que ya están corregidas. `Postgrex.transaction` lanza una excepción cuando no hay conexión, en lugar de devolver un error, y eso tumbaba al poller y al canal de quien enviaba; ahora siempre devuelve `{:error, _}`. Y la cola por instancia del fanout era efímera, así que un reinicio de RabbitMQ perdía eventos; ahora es durable y con vencimiento (ver ADR-016).

Dejamos afuera de esta decisión los reintentos con límite y la cola de eventos fallidos, que llegaron después en el ADR-030, y la entrega al cliente final, que sigue siendo de mejor esfuerzo: un cliente desconectado se pone al día con el historial y con `changes_since`.
