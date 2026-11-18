# ADR-017: messaging decide permisos, menciones y existencia de usuarios con una réplica local alimentada por eventos

**Estado:** Aceptada
**Fecha:** 2026-10-09
**Servicios:** `messaging`, `servers`, `identify-service`, `events-contract`
**Relacionadas:** ADR-014 (tickets del WebSocket), ADR-018 (outbox), ADR-030 (entrega de eventos), ADR-031 (contrato de eventos)

## Contexto

Al principio `messaging` le preguntaba a otros servicios por HTTP, en el momento y con el JWT del usuario, casi todo lo que necesitaba saber: si alguien podía ver un canal, escribir o moderar (a `servers`), qué menciones eran válidas y a quién avisar (a `servers`), y si un destinatario existía antes de abrir un mensaje directo o bloquearlo (a `identify-service`). Esas consultas ocurrían con cada mensaje, edición, borrado, entrada a un canal y mención.

Eso nos traía varios problemas. Si `servers` o `identify-service` se caían, `messaging` dejaba de aceptar mensajes aunque sus propios datos estuvieran sanos, y una caída a medias de `servers` frenaba el chat de todos los servidores. Cada acción pagaba además una ida y vuelta de red, y el JWT del usuario tenía que viajar y guardarse en `messaging`, que es el riesgo que dejamos anotado en el ADR-014. Mientras tanto, el resto de la plataforma ya trabajaba con eventos (outbox en `servers` e `identify-service`, exchange `discordia.events`), y `servers` ya tenía una réplica de perfiles armada así. La revisión semanal del 9 de octubre pidió justamente pasar las consultas síncronas a asíncronas.

## Decisión

`messaging` deja de llamar a otros servicios para autorizar. Guarda en su propio Mongo una copia de lo mínimo que necesita, la mantiene al día con eventos y calcula las respuestas localmente.

La copia tiene cinco colecciones, cada una alimentada por eventos de quien es dueño del dato:

| Colección | Qué guarda | Eventos que la alimentan |
|---|---|---|
| `replica_servers` | dueño de cada servidor | `servers.owner_updated` |
| `replica_roles` | permisos del rol y si es `@everyone` | `servers.role_updated`, `servers.role_deleted` |
| `replica_members` | roles de cada miembro | `servers.member_roles_updated`, `servers.member_left` |
| `replica_overrides` | permisos por rol de cada canal | `servers.channel_overrides_updated`, `servers.channel_deleted` |
| `replica_users` | solo el `user_id` y su versión | `users.profile_updated` |

No se guardan nombres, colores, correos ni perfiles, solo lo necesario para decidir.

Los eventos son fotos completas de una entidad y no diferencias: llevan todos los permisos de un rol, todos los roles de un miembro o todos los overrides de un canal. Eso hace que el consumidor no necesite conocer el estado anterior, que un evento repetido no cambie nada y que uno que llega tarde no pise a otro más nuevo. El orden se resuelve con `occurred_at` de la entidad (`profile_updated` usa `version`): el consumidor escribe con un filtro atómico y, si ya tiene algo más nuevo, descarta el evento y lo deja registrado. Cuando algo se borra queda una lápida durante 7 días, para que una foto vieja no lo resucite. Los permisos viajan por nombre (`VIEW_CHANNELS`, por ejemplo) y nunca como máscara de bits, para no atar al consumidor al orden interno de `servers`.

El cálculo de permisos efectivos vive en una función pura, `Messaging.Chat.Permissions`, que repite la regla de `servers`. El dueño y los administradores pueden todo y los overrides no los alcanzan. El resto parte de la unión de los permisos de sus roles, aplica el override de `@everyone` y luego los de sus otros roles, donde `allow` le gana a `deny`. Quien no es miembro no puede nada, y un rol que ya no existe no otorga nada. Las menciones se resuelven con el mismo criterio: un usuario mencionado cuenta si es miembro, los roles y `@everyone` solo si quien escribe tiene `MENTION_EVERYONE`, y se avisa únicamente a quienes ven el canal.

Como RabbitMQ no guarda lo que se publicó antes de que existiera la cola, para arrancar hubo que re-publicar todo: `servers` lo hace con la migración `0022_backfill_access_events` e `identify-service` con `000016_republish_profile_events`. Esas fotos llevan una fecha posterior a cualquier cambio anterior, así que correrlas de nuevo o en medio de cambios en vivo es seguro. El orden de despliegue importa: primero `messaging`, que declara las nuevas claves de ruteo en su cola, y después `servers` e `identify-service`. Al revés, los eventos del backfill se pierden y hay que volver a correr la migración.

## Alternativas descartadas

Pensamos en seguir con HTTP y agregar caché, reintentos y un circuit breaker. Pero eso sigue dependiendo de `servers` para la primera consulta y para cada invalidación, y el caché terminaría siendo una réplica sin eventos que la mantengan al día.

También consideramos que `servers` publicara los permisos efectivos ya calculados por usuario y canal. Evitaría duplicar la regla, pero el volumen es usuarios por canales, y un cambio de rol en un servidor grande generaría miles de eventos.

Los eventos con diferencias (`role_permission_added` y parecidos) los descartamos porque exigen orden estricto y conocer el estado previo: si se pierde uno, la copia queda mal para siempre.

Por último, probamos la idea de una réplica con respaldo por HTTP cuando falta un dato. Mantiene el acoplamiento que queríamos sacar y esconde los errores de la réplica. Preferimos denegar y que el backfill arregle el dato.

## Consecuencias

Lo principal que ganamos es que `servers` e `identify-service` pueden estar caídos y el chat sigue andando. Una consulta de permisos pasa a ser un par de lecturas locales en Mongo en lugar de una llamada de red, y varias instancias de `messaging` leen la misma réplica sin estado propio. Además `messaging` ya no recibe ni guarda el JWT del usuario: el ticket del WebSocket guarda solo el `user_id`, y pudimos eliminar la dependencia del cliente HTTP y las variables `SERVERS_BASE_URL` e `IDENTIFY_BASE_URL`.

A cambio tenemos consistencia eventual. Un cambio de permisos tarda lo que demore el poller de `servers` (unos 2 segundos) más la entrega, y en ese lapso se aplica la regla anterior; el corte de sockets cuando se revoca el acceso a un canal sigue funcionando por su lado. Un usuario recién registrado no existe para `messaging` hasta que llega su `users.profile_updated`, así que un mensaje directo o un bloqueo en esos segundos devuelve `RECIPIENT_NOT_FOUND` o `USER_NOT_FOUND`. Y como un dato que todavía no llegó se lee como "no permitido", un backfill incompleto se nota como 403 y no como un error del servicio.

También asumimos que la regla de permisos queda escrita dos veces, en Go en `servers` y en Elixir en `messaging`. Lo mitigamos con pruebas que fijan cada capa de la regla (roles, `@everyone`, overrides, dueño, administrador, rol borrado); si la regla cambia en `servers`, hay que cambiarla acá y en esas pruebas. Y la réplica ocupa más espacio en Mongo, con una fila por rol, por miembro y por canal con overrides.

Esta decisión no resuelve la baja de cuentas: `identify-service` no publica un evento de usuario borrado, así que la réplica de usuarios no elimina a nadie. Tampoco define por sí sola qué pasa con un evento que falla una y otra vez ni cómo se versionan los campos; de eso se ocupan el ADR-030 y el ADR-031.
