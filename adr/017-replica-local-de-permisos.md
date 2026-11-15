# ADR-017: messaging decide permisos, menciones y existencia de usuarios con una réplica local alimentada por eventos

**Estado:** Aceptada  
**Fecha**: 2026-10-09  
**Servicios**: `messaging`, `servers`, `identify-service`, `events-contract`, `docs` (AsyncAPI)  
**Decidida por**: Facundo Madotta (diseño e implementación)  
**Pedida por**: Revisión semanal del 2026-10-09: pasar todas las consultas síncronas a asíncronas  
**Reemplaza**: La decisión de consultar por HTTP con reintentos y *circuit breaker* (nunca llegó a escribirse como ADR)

## 1. Contexto

Para cada mensaje, edición, borrado, `join` a un canal y mención, `messaging` le preguntaba a otro servicio por HTTP, en el momento y con el JWT del usuario:

- **`PermissionsClient`**: Pregunta: ¿puede ver el canal / escribir / moderar mensajes?; Servicio: `servers`
- **`MentionsClient`**: Pregunta: ¿qué menciones valen y a quién se avisa?; Servicio: `servers`
- **`UsersClient`**: Pregunta: ¿existe este destinatario (primer DM y bloqueos)?; Servicio: `identify-service`

Problemas: si `servers` o `identify-service` caen, `messaging` deja de aceptar mensajes aunque sus datos estén sanos; cada acción paga una ida y vuelta de red; el JWT del usuario tenía que viajar y guardarse (ADR-014, riesgo 1); y una caída de `servers` a medias tumba la mensajería de todos los servidores.

El resto de la plataforma ya funciona con eventos (outbox transaccional en `servers` e `identify-service`, `discordia.events`), y `servers` ya tiene una réplica de perfiles construida así.

## 2. Decisión

`messaging` **no llama a nadie** para autorizar. Guarda en su propio Mongo una copia de lo mínimo necesario, la mantiene con eventos y calcula las respuestas localmente.

### 2.1 Qué se replica

- **`replica_servers`**: Qué guarda: dueño del servidor; Evento que la alimenta: `servers.owner_updated`; Publica: `servers`
- **`replica_roles`**: Qué guarda: permisos del rol e `is_everyone`; Evento que la alimenta: `servers.role_updated`, `servers.role_deleted`; Publica: `servers`
- **`replica_members`**: Qué guarda: roles de cada miembro (`@everyone` incluido); Evento que la alimenta: `servers.member_roles_updated`, `servers.member_left`; Publica: `servers`
- **`replica_overrides`**: Qué guarda: overrides por rol de cada canal; Evento que la alimenta: `servers.channel_overrides_updated`, `servers.channel_deleted`; Publica: `servers`
- **`replica_users`**: Qué guarda: `user_id` y `version`; Evento que la alimenta: `users.profile_updated`; Publica: `identify-service`

No viajan ni se guardan nombres, colores, emails ni perfiles: solo lo que hace falta para decidir.

### 2.2 Eventos: fotos completas, no diferencias

Cada evento trae el **estado completo de una entidad** (todos los permisos de un rol, todos los roles de un miembro, todos los overrides de un canal), como ya hace `users.profile_updated`. Así:

- el consumidor no necesita conocer el estado anterior,
- un evento repetido no cambia nada,
- uno que llega tarde no pisa a uno más nuevo.

El orden se resuelve por `occurred_at` de la entidad (`profile_updated` usa `version`): el consumidor escribe con un filtro atómico `at <= nuevo` y, si ya hay algo más nuevo, descarta el evento (`ignored_stale`, auditado). Los borrados dejan una lápida con TTL de 7 días para que una foto vieja no resucite lo borrado. Los permisos viajan **por nombre** (`VIEW_CHANNELS`, ...), nunca como máscara, para no atar al consumidor al orden interno de `servers`.

Borrar un rol no publica un evento por cada miembro u override que lo tenía: el consumidor lo saca de sus copias al recibir `servers.role_deleted`. Borrar un canal o un servidor arrastra sus overrides.

### 2.3 Decisión local

`Messaging.Chat.Permissions` (función pura) calcula los permisos efectivos con **la misma regla que `servers`**: el dueño y los administradores pueden todo y los overrides no los alcanzan; el resto parte de la unión de los permisos de sus roles, aplica el override de `@everyone` y después los de sus otros roles, donde `allow` gana a `deny`. Un no miembro no puede nada. Un rol que ya no existe no otorga nada.

Las menciones se resuelven igual (`MentionResolver.Replica`): un usuario mencionado cuenta si es miembro; los roles y `@everyone` solo si quien escribe tiene `MENTION_EVERYONE` (el dueño y los administradores lo tienen implícito); se avisa a quienes **ven ese canal**, es decir, ya con los overrides aplicados.

### 2.4 Recuperación y alta

RabbitMQ no guarda lo que se publicó antes de que existiera la cola. Por eso:

- `servers` re-publica todo con la migración `0022_backfill_access_events` (dueños, roles, roles de cada miembro, overrides),
- `identify-service` re-publica todos los perfiles con `000016_republish_profile_events`,
- `occurred_at` del backfill tiene precisión de microsegundos y es posterior a cualquier cambio anterior, así que correrlo de nuevo o mezclado con cambios en vivo es seguro.

**Orden de despliegue obligatorio:** primero `messaging` (declara las nuevas claves de ruteo en su cola), después `servers` e `identify-service` (sus migraciones publican el backfill). Al revés, los eventos se pierden y hay que volver a correr el INSERT de la migración.

## 3. Alternativas descartadas

- **Seguir con HTTP y sumar caché + reintentos + *circuit breaker***: Sigue dependiendo de `servers` para el primer pedido y para cada invalidación; el caché sería una réplica sin eventos que la mantengan al día.
- **`servers` publica los permisos efectivos ya calculados por usuario y canal**: Evita duplicar la regla, pero el volumen es usuarios × canales y un cambio de rol en un servidor grande genera miles de eventos.
- **Eventos con diferencias (`role_permission_added`, ...)**: Exigen orden estricto y conocer el estado previo; un evento perdido deja la copia mal para siempre.
- **Réplica con respaldo HTTP cuando falta el dato**: Mantiene el acoplamiento que se quería sacar y esconde los errores de la réplica. Se prefiere denegar y que el backfill arregle el dato.

## 4. Consecuencias

### Positivas

- `servers` e `identify-service` pueden estar caídos sin que se frene la mensajería.
- Una consulta de permiso cuesta lecturas locales en Mongo, no una petición de red.
- `messaging` ya no recibe ni guarda el JWT del usuario: el ticket del WebSocket guarda solo `user_id` (ADR-014, riesgos 1 y 2, resueltos), y se eliminó la dependencia `req` y las variables `SERVERS_BASE_URL` e `IDENTIFY_BASE_URL`.
- Varias instancias de `messaging` leen la misma réplica en Mongo: no hay estado por instancia.

### Negativas y riesgos conocidos

1. **Consistencia eventual.** Un cambio de permisos tarda el poller de `servers` (unos 2 s) más la entrega en llegar. En ese lapso se aplica la regla anterior. El corte de sockets por `servers.channel_access_revoked` sigue funcionando aparte.
1. **La regla de permisos está escrita dos veces** (Go en `servers`, Elixir en `messaging`). Mitigación: `test/messaging/chat/permissions_test.exs` fija cada capa de la regla (roles, `@everyone`, overrides por rol, dueño, administrador, rol borrado). Si la regla cambia en `servers` (`internal/model/channelperm`), hay que cambiarla acá y en esas pruebas.
1. **Un usuario recién registrado** no existe para `messaging` hasta que llega su `users.profile_updated`. Un DM o un bloqueo en esos segundos devuelve `RECIPIENT_NOT_FOUND` / `USER_NOT_FOUND`. Ya no hay respaldo por HTTP.
1. **Datos ausentes se leen como "no permitido".** Un miembro o un rol que todavía no llegó se trata como inexistente. Un backfill incompleto produce 403 en lugar de errores del servicio.
1. **Más almacenamiento** en Mongo (una fila por rol, por miembro y por canal con overrides).
1. **Sin validación de schema ni cola de eventos fallidos todavía** (ver "Lo que no cubre").

## 5. Lo que no cubre

- Validación automática del schema de cada evento (JSON Schema generado del AsyncAPI).
- Cola de eventos fallidos (DLQ) con límite de reintentos: hoy un evento que falla se reencola con espera.
- Política escrita de versionado y baja de campos de un evento.
- Procedimiento de *replay* y retención del outbox y de `consumed_events`.
- Baja de cuentas: `identify-service` no publica un evento de usuario borrado, así que la réplica de usuarios no borra a nadie.

## 6. Seguimiento

- Subir el tag `v0.7.0` de `events-contract` y fijarlo en `servers`: hasta entonces su `go.mod` usa un `replace` local que **no sirve para CI ni para el build de Docker**.
- Prueba con dos instancias de `messaging` leyendo la misma réplica.
- Decidir el plazo de retención de los eventos publicados.

## 7. Verificación (2026-10-09)

- **El esquema de cada evento no cambia sin querer**: `events-contract/permissions/events_test.go` (forma JSON)
- **Cada escritura de `servers` publica la foto correcta, y ninguna escritura rechazada publica**: `servers/test/repository/access_events` (15 casos, Postgres real)
- **El backfill re-anuncia roles, miembros, overrides y dueño**: mismo paquete, `TestBackfill_AnnouncesEverythingAlreadyStored`
- **La regla de permisos efectivos**: `messaging/test/messaging/chat/permissions_test.exs`
- **Orden, repetidos y lápidas de la réplica**: `messaging/test/messaging/chat/repo/replica_mongo_test.exs` (Mongo real)
- **De evento a decisión, sin llamar a nadie**: mismo archivo y `channel_lifecycle_consumer_test.exs` (RabbitMQ y Mongo reales)
- **`messaging` ya no guarda el JWT**: `socket_ticket_test.exs`, `socket_ticket_controller_test.exs`, `user_socket_test.exs`

Código: `messaging/lib/messaging/chat/{permissions,replica}.ex`, `permissions_store/replica.ex`, `mention_resolver/replica.ex`, `events/lifecycle.ex`; `servers/internal/repository/access_events.go`; `events-contract/permissions/`; `docs/asyncapi/permissions.yaml`.
