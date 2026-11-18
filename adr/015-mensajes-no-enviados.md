# ADR-015: Manejo de mensajes no enviados

**Estado:** Aceptado
**Servicios:** `messaging`, `web-client`, `app-mobile`, `client-shared`
**Relacionadas:** ADR-016 (propagación), ADR-018 (outbox)

## Contexto

Las historias de envío de mensajes, en canal y por mensaje directo, definen el envío exitoso, el mensaje vacío, la falta de permisos, el largo máximo y el bloqueo, pero no dicen qué pasa cuando un mensaje no llega por un problema de conexión: un corte de red, un socket caído o una respuesta perdida. El envío es por WebSocket y estas fallas suelen ser breves, porque la conexión se recupera sola en segundos. Hasta entonces, un mensaje que fallaba quedaba marcado como fallido solo en memoria: no se reintentaba, el usuario no podía reenviarlo ni descartarlo, y el texto se perdía al cambiar de chat o al recargar.

Reintentar trae un problema nuevo: el mismo mensaje puede llegar más de una vez a `messaging`. Hasta ahora cada envío era un pedido único y el servicio le asignaba un id nuevo, así que si el primer intento se guardaba pero la respuesta no llegaba al cliente, el reintento se iba a registrar como otro mensaje. Y como el evento que anuncia el mensaje se anota en el outbox antes de insertarlo en Mongo (ADR-018), un índice único en Mongo no alcanza: si dos intentos se procesan a la vez, el insert repetido se rechaza, pero los dos avisos ya quedaron encolados.

## Decisión

Los clientes se encargan de los mensajes que no se pudieron enviar, apoyados en un envío idempotente en `messaging`.

En el cliente, el mensaje aparece en el chat apenas se envía, antes de que el servidor lo confirme. Si falla, se reintenta solo hasta 3 veces, con esperas de 1 y 3 segundos. Si no hay conexión, los mensajes esperan en una cola por chat sin gastar intentos y salen en orden al reconectar. Si se agotan los intentos, el mensaje se queda en el chat marcado como no enviado y el usuario decide si lo reintenta o lo elimina. Los mensajes de solo texto sin confirmar se guardan en el dispositivo durante 2 horas (en `localStorage` en la web y en `AsyncStorage` en la app), así que sobreviven a un cambio de chat o a una recarga; al volver aparecen como no enviados y no se reenvían solos.

En `messaging`, la app genera un identificador único por mensaje, el `client_id`, y lo repite en todos sus reintentos, para que el servicio reconozca que varios pedidos son el mismo mensaje. Es opcional: si un cliente no lo manda, por ejemplo una versión vieja, el mensaje se guarda como antes, con un id aleatorio. Cuando llega un `client_id`, el id del mensaje se calcula (un UUID v5) a partir del canal, el usuario y el `client_id`, de modo que todos los intentos producen el mismo id, y si el mensaje ya existe se devuelve el existente sin repetir efectos como las menciones o el último mensaje de la conversación. Para los intentos simultáneos, el outbox tiene un índice único por evento, destino e id de mensaje sobre los eventos de creación; si dos intentos se procesan a la vez, el segundo no encola nada y devuelve el mensaje existente.

## Alternativas descartadas

- **Un índice único sobre los mensajes en Mongo.** Evita guardar el mensaje dos veces, pero no que se publique dos veces, porque el aviso se anota en el outbox antes de guardar el mensaje.
- **Deduplicar por contenido y ventana de tiempo.** Confundiría dos mensajes iguales y legítimos con un reintento.
- **No reintentar y dejar todo en manos del usuario.** Es lo más simple, pero un corte de un par de segundos le haría perder mensajes o lo obligaría a reenviar a mano.
- **Que los clientes deduplicaran lo que reciben.** Dejaría a cada receptor la tarea de descartar repetidos, en lugar de garantizar la idempotencia en el servidor.

## Consecuencias

Un corte de conexión breve no le hace perder mensajes al usuario: se envían solos al reconectar. Ante una falla definitiva conserva el texto y decide qué hacer, incluso después de recargar. Y reintentar nunca produce duplicados, aunque el primer intento haya llegado al servidor o los dos intentos se procesen a la vez, porque la idempotencia la garantiza el servidor y no depende de que cada receptor descarte avisos repetidos.

A cambio, el texto sin enviar queda sin cifrar en el dispositivo hasta 2 horas, se borra al cerrar sesión y pasado ese plazo se descarta sin aviso. Los mensajes con adjuntos no se guardan ni entran en la cola, así que si fallan solo se conserva el borrador. Y los clientes se vuelven más complejos, porque ahora manejan estados del mensaje, temporizadores y persistencia local.
