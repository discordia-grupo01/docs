# ADR-045: El aviso al dueño de un servidor eliminado por el staff viaja en un evento firmado propio y lo guarda notifications

**Estado:** Aceptada
**Fecha:** 2026-11-20
**Servicios:** `events-contract`, `admin`, `notifications`, `gateway`, `infrastructure`, `client-shared`, `web-client`, `app-mobile`
**Historia:** "Eliminar servidor desde backoffice": el propietario ve un modal que le avisa que su servidor fue eliminado
**Relacionadas:** ADR-007 (pub/sub), ADR-018 (outbox en Postgres), ADR-030 (entrega de eventos), ADR-031 (contrato de eventos generado), ADR-032 (avisos de cambio en tiempo real), ADR-041 (eventos firmados con HMAC)

## Contexto

Cuando el staff elimina un servidor desde el backoffice, `admin` publica `admin.server_deletion_requested` y `servers` ejecuta el mismo borrado que cuando lo pide el dueño: un `servers.member_left` por miembro y `servers.server_deleted`. A propósito, los dos borrados son idénticos para el resto de la plataforma.

La historia pide que el dueño vea un modal que le diga que su servidor fue eliminado, como pasa cuando se suspende una cuenta. Con lo que había, eso no se podía hacer:

- A las apps solo les llega `server_left` por la sala `user:<id>` de `messaging`. Es el mismo aviso que cuando el dueño borra su propio servidor o cuando alguien se va, así que el front no puede distinguir que lo borró el staff.
- Ningún evento dice quién es el dueño ni cómo se llamaba el servidor. Después del borrado, el nombre no existe en ningún lado.
- Si el dueño no estaba conectado cuando lo borraron, no recibe nada. Cuando vuelve, el servidor directamente no aparece en su lista. La suspensión de cuenta no tiene este problema porque es un estado que sigue existiendo y el login lo informa. Un servidor borrado no deja nada que consultar.

`messaging` y `notifications` guardan una réplica de cada servidor con su dueño. Pero esa réplica se borra al recibir `servers.server_deleted`, y RabbitMQ no garantiza que el pedido de admin llegue antes que los eventos del borrado. Un aviso que dependa de la réplica puede no encontrar al dueño.

## Decisión

**Admin publica un evento nuevo, `admin.server_deletion_notice`, en la misma transacción que el pedido de borrado.** Lleva `server_id`, `owner_id` y `server_name`, que admin ya tiene en su réplica de servidores (`servers.server_updated`) en el momento del pedido. Como sale del outbox en la misma transacción, o se publican los dos eventos o ninguno (ADR-018). Así el aviso no depende de ninguna réplica que se borre, y no hay carrera con el borrado.

**El evento va firmado con HMAC, como el resto de los de `admin` (ADR-041).** El texto firmado es `routing_key \n event_id \n server_id \n owner_id \n server_name \n occurred_at`. El dueño y el nombre van firmados para que un aviso válido no se pueda reenviar a otro usuario ni con otro texto. `server_name` es el único campo de texto libre y los demás tienen formato fijo, así que el texto firmado no es ambiguo aunque el nombre tenga un salto de línea. No lleva `version`: el aviso no cambia ningún estado, solo se muestra una vez.

**Notifications lo consume y lo guarda.** Verifica la firma con `ADMIN_EVENTS_HMAC_SECRET`; si no verifica, descarta el evento y lo deja en la auditoría. Si verifica, guarda el aviso en la colección `staff_notices` con id `owner_id:server_id`. Lo inserta solo si no existe, así que un pedido de borrado repetido no vuelve a mostrar un aviso que el dueño ya vio. Después le manda al dueño un aviso de cambio con el recurso `notices` por su sala `user:<id>` (ADR-032).

**El front lo pide por REST.** Notifications expone dos endpoints autenticados:

- `GET /v1/notifications/notices` devuelve los avisos que el usuario todavía no vio.
- `POST /v1/notifications/notices/:id/seen` marca uno como visto.

Las apps piden los avisos al entrar y cada vez que llega el cambio `notices`. Si hay uno, muestran el modal. Al cerrarlo, lo marcan como visto. El aviso por socket cubre al dueño conectado y el `GET` cubre al que estaba desconectado.

**Solo lo ve el dueño.** El evento lleva solo al dueño, y el resto de los miembros sigue como hasta ahora: el servidor desaparece de su lista con `server_left`.

## Alternativas descartadas

- **Agregar `owner_id` y `server_name` al evento `admin.server_deletion_requested`.** Para que no se puedan falsificar, tendrían que entrar en la firma. Pero `servers` verifica ese evento antes de borrar. Si admin se desplegara antes que `servers`, `servers` rechazaría el pedido por firma inválida y el servidor no se borraría, sin ningún error visible para el staff. Un evento aparte no toca el borrado.
- **Agregar esos campos al evento sin firmarlos.** Evita el problema del despliegue, pero quien tenga acceso al broker podría tomar un pedido válido, cambiarle el dueño y el nombre, y mostrarle un aviso falso a cualquiera.
- **Que `messaging` consuma `admin.server_deletion_requested` y avise por la sala `user:<id>`.** Tiene la carrera con la réplica, y solo le llega al dueño si está conectado en ese momento.
- **Resolverlo solo en el front.** Mostrar el modal cuando llega `server_left` de un servidor propio que no se borró desde esta sesión. Si el dueño lo borró desde otro dispositivo, le aparecería el modal igual, y si estaba desconectado no se entera.
- **Guardarlo en el historial de notificaciones.** Notifications ya guarda ahí las menciones, los DMs y las transferencias de propiedad. Pero la historia pide un modal, no una entrada en el centro de notificaciones, y mezclarlo obligaría a filtrarlo en las dos apps.
- **Mandar los avisos pendientes por el socket de notifications en vez de por REST.** También funciona, pero el historial ya usa REST para listar y marcar como leído, y las dos apps ya consumen notifications así.
- **Borrar el aviso apenas se manda por el socket, sin un "visto".** Si el dueño cierra la app justo antes de que aparezca el modal, el aviso se pierde y no lo ve nunca.

## Consecuencias

El dueño se entera siempre de que el staff eliminó su servidor, esté conectado o no, y ve el nombre del servidor aunque ya no exista. El borrado no cambia: `servers` y el evento que verifica siguen igual.

Notifications pasa a tener `ADMIN_EVENTS_HMAC_SECRET`, que hasta ahora tenían solo `identify-service`, `servers`, `messaging`, `voice-sfu` y `metrics`. Rotar ese secreto ahora también obliga a actualizarlo en notifications.

Si notifications está caído, el aviso espera en su cola y se guarda al volver. Si el dueño todavía no entró, lo ve en su próximo ingreso.

Los avisos vistos quedan guardados. Hoy no hay retención: si la colección crece, se puede sumar un TTL sobre `seen_at`.

Orden de despliegue: notifications antes que admin. Si admin publica el aviso antes de que exista la cola que lo escucha, el aviso se pierde (misma lección que ADR-017 y ADR-024). Hace falta un tag nuevo de `events-contract`, y admin y notifications tienen que apuntar a ese tag.
