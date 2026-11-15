# ADR-015: Manejo de mensajes no enviados

**Estado:** Aceptado

## Contexto

Las historias de usuario de envío de mensajes (en canal y por DM) definen el envío exitoso, el mensaje vacío, la falta de permisos, el largo máximo y el bloqueo, pero no qué ocurre cuando un mensaje no llega por un problema de conexión (corte de red, socket caído o respuesta perdida). El envío se hace por WebSocket, y estas fallas suelen ser breves: la conexión se recupera sola en segundos. Hasta ahora, un mensaje que fallaba quedaba marcado como fallido solo en memoria: no se reintentaba, el usuario no podía reenviarlo ni descartarlo, y el texto se perdía al cambiar de chat o recargar. Reintentar implica que un mismo mensaje puede llegar más de una vez al servicio de Mensajería, algo que hasta ahora no ocurría: cada envío era un único pedido y el servicio le asignaba un id nuevo. Con reintentos, si el primer intento se guarda pero la respuesta no llega al cliente, el siguiente se registraría como un mensaje distinto. Además, el evento que anuncia un mensaje se encola en el outbox antes de insertarlo en MongoDB, por lo que un índice único en MongoDB no alcanza para reconocer los intentos repetidos: si dos intentos se procesan a la vez, el insert repetido se rechaza, pero los dos avisos ya quedaron encolados.

## Decisión

Manejar en los clientes los mensajes que no se pudieron enviar, apoyados en un envío idempotente en el servicio de Mensajería.

- **Envío optimista:** el mensaje se muestra en el chat apenas el usuario lo envía, antes de que el servidor lo confirme.
- **Reintento automático:** hasta 3 intentos, con esperas de 1 y 3 segundos, sin que el usuario intervenga.
- **Cola sin conexión:** si no hay conexión, los mensajes esperan en una cola por chat sin gastar intentos y se envían en orden al reconectar.
- **Falla definitiva:** si se agotan los intentos, el mensaje se mantiene en el chat marcado como no enviado y el usuario decide si reintentarlo o eliminarlo.
- **Persistencia local:** los mensajes de solo texto sin confirmar se guardan en el dispositivo durante 2 horas, en *localStorage* en web y en *AsyncStorage* en mobile, de modo que sobreviven a un cambio de chat o a una recarga. Al recargar vuelven como no enviados y no se reenvían solos.

En el servicio de Mensajería:

- **Identificador de cliente** (`client_id`)**: la app genera un identificador único para cada mensaje al enviarlo y lo repite en todos sus reintentos, para que el servicio reconozca que distintos pedidos corresponden al mismo mensaje. Es opcional: si un cliente no lo envía (por ejemplo, una versión anterior), el mensaje se guarda como hasta ahora, con un id aleatorio.
- **Id determinístico**: cuando llega un `client_id`, el id del mensaje se calcula (UUID v5) a partir del canal, el usuario y el `client_id`, así que todos los intentos producen el mismo id. Si el mensaje ya existe, se devuelve el existente sin repetir efectos secundarios (menciones, último mensaje de la conversación).
- **Intentos simultáneos:** el outbox tiene un índice único por evento, destino e id de mensaje sobre los eventos de creación (`new_message`, `new_dm` y `messaging.message_created`). Si dos intentos se procesan a la vez, el segundo no encola nada y devuelve el mensaje existente.

Se eligió un id determinístico junto con un índice único en el outbox, en lugar de un índice único sobre los mensajes en MongoDB, que evita guardar el mensaje dos veces pero no que se publique dos veces (el aviso se encola en el outbox antes de guardar el mensaje). También se descartó la deduplicación por contenido y ventana de tiempo, que confundiría mensajes iguales y legítimos con reintentos.

## Consecuencias

- **Positivas:**
    - Un corte de conexión breve no le hace perder mensajes al usuario: se envían solos al reconectar.
    - Ante una falla definitiva el usuario conserva el texto y decide qué hacer con él, incluso después de recargar.
    - Reintentar nunca produce duplicados, aunque el primer intento haya llegado al servidor o los dos intentos se procesen a la vez. La idempotencia se garantiza en el servidor y no depende de que cada receptor descarte avisos repetidos.
- **Negativas**:
    - El texto sin enviar queda sin cifrar en el dispositivo hasta 2 horas (se borra al cerrar sesión), y pasado ese plazo se descarta sin aviso.
    - Los mensajes con adjuntos no se persisten ni entran en la cola: si fallan, solo se conserva el borrador.
    - Mayor complejidad en los clientes (estados del mensaje, temporizadores y persistencia local).
