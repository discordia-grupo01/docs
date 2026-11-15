# ADR-028: voice-sfu autoriza la unión a canales de voz con una réplica local alimentada por eventos, en lugar de HTTP síncrono hacia servers

**Estado:** Aceptada  
**Fecha:** 2026-11-13  
**Servicios:** voice-sfu, servers, events-contract, docs (AsyncAPI)  
**Reemplaza:** ADR-013 (comunicación síncrona para la unión al chat de voz)  
**Relacionadas:** ADR-012 (LiveKit), ADR-017 (réplica local en messaging), ADR-020 (réplica local en notifications), ADR-024 (réplica en admin)

## 1. Contexto

Al unirse a un canal de voz, voice-sfu necesita saber si el canal existe, si es de voz y si el usuario puede entrar. Esa información pertenece a servers. El ADR-013 lo resolvió con una petición HTTP síncrona de voice-sfu a servers en cada unión: servers valida canal, tipo, membresía, roles y permisos, y recién entonces voice-sfu emite el token de LiveKit, con la sala derivada del id del canal. Era la única excepción a la regla de que los servicios se comunican por eventos.

Desde entonces messaging (ADR-017) y notifications (ADR-020) pasaron a decidir con una réplica local alimentada por eventos, y admin armó su expediente de la misma forma (ADR-024). Voz quedó como el único servicio que le pregunta a servers en línea.

El esquema síncrono tiene los costos que el ADR-013 ya había anticipado, más uno que apareció después:

- Si servers no responde, nadie puede unirse a voz, aunque LiveKit y voice-sfu estén sanos.
- La latencia del HTTP se suma al ingreso al canal.
- Cada unión debe manejar timeouts y errores de red de servers.
- Los eventos que consume voice-sfu se guardan en memoria y se pierden al reiniciar el servicio.

La revisión del 09/10 con la cátedra ya había pedido pasar las consultas síncronas entre servicios a asíncronas.

## 2. Decisión

voice-sfu **no llama a** **servers** para autorizar una unión. Guarda en su propia base una copia de lo mínimo necesario, la mantiene con eventos asíncronos de discordia.events y decide localmente si emite el token de LiveKit. La réplica se puede reconstruir en cualquier momento con un backfill que servers re-publica.

### 2.1 Qué se replica

voice-sfu consume los mismos eventos que ya publica servers y consumen messaging y notifications, con una cola durable propia (voice_sfu.access_replica). No se crean eventos nuevos.

| Colección | Qué guarda | Eventos que la alimentan |
|---|---|---|
| replica_channels | Id, servidor y tipo (texto o voz) del canal | servers.channel_created, servers.channel_deleted, servers.server_deleted |
| replica_servers | Dueño del servidor | servers.owner_updated |
| replica_roles | Permisos del rol e is_everyone | servers.role_updated, servers.role_deleted |
| replica_members | Roles de cada miembro, @everyone incluido | servers.member_joined, servers.member_roles_updated, servers.member_left |
| replica_overrides | Overrides por rol de cada canal | servers.channel_overrides_updated, servers.channel_deleted |

No se guardan nombres, colores, emails ni perfiles: solo lo necesario para decidir. La base es MongoDB, igual que las réplicas de messaging y notifications.

### 2.2 Eventos: fotos completas y orden

Se mantiene el criterio del ADR-017. Cada evento trae el estado completo de una entidad, por lo que un evento repetido no cambia nada y uno tardío no pisa a uno más nuevo. El consumidor escribe con un filtro atómico sobre occurred_at (el dato guardado debe ser menor o igual al nuevo) y, si ya hay algo más reciente, descarta el evento como ignored_stale. Los borrados dejan una lápida con TTL de 7 días para que una foto vieja no resucite lo borrado. Los permisos viajan por nombre, nunca como máscara.

### 2.3 Decisión local al unirse

1. El cliente pide el token de unión a voice-sfu, igual que antes.
1. voice-sfu busca el canal en replica_channels y verifica que exista y sea de voz.
1. Verifica que el usuario sea miembro y calcula sus permisos efectivos con la misma regla que servers: el dueño y los administradores pueden todo; el resto parte de la unión de sus roles, aplica el override de @everyone y luego los de sus otros roles, donde allow gana a deny.
1. Si puede ver el canal y unirse, deriva la sala del id del canal y emite el token de LiveKit. Si no, responde 403.

Un dato ausente se lee como no permitido. Quien ya está conectado a una sala sigue gobernado por los eventos de acceso revocado y de canal o servidor eliminado, que no cambian.

### 2.4 Backfill

RabbitMQ no entrega lo publicado antes de que existiera la cola, y una réplica nueva o recreada arranca vacía. Por eso el backfill es parte de la decisión y no una tarea de una sola vez:

- servers es la fuente de verdad. La réplica es descartable y reconstruible.
- El backfill es una re-publicación completa de fotos: canales, dueños, roles, roles de cada miembro y overrides. Reutiliza el mecanismo del ADR-017 (migración 0022_backfill_access_events) y lo extiende a los canales.
- Se corre al desplegar voice-sfu por primera vez, al recrear su base o su cola, y cuando se detecta un hueco.
- Es seguro repetirlo o mezclarlo con cambios en vivo: las fotos son idempotentes y el filtro por occurred_at descarta lo viejo. No requiere detener ningún servicio.
- **Orden de despliegue obligatorio:** primero voice-sfu (declara su cola y sus claves de ruteo), después el backfill de servers. Al revés, los eventos se pierden y hay que volver a correrlo.

## 3. Alternativas descartadas

- **Mantener HTTP síncrono con timeout, reintentos y circuit breaker:** reduce el impacto de una falla, pero la unión sigue dependiendo de servers y sería la única consulta síncrona que quedaría en la plataforma.
- **Caché con TTL sobre la respuesta HTTP:** el primer pedido y cada invalidación siguen dependiendo de servers, y no hay eventos que la mantengan al día.
- **Réplica con respaldo HTTP cuando falta el dato:** conserva el acoplamiento que se quiere eliminar y esconde los errores de la réplica. Se prefiere denegar y que el backfill corrija el dato.
- **Leer directamente la base de** **servers****:** rompe el aislamiento de datos de cada servicio.
- **Eventos con diferencias en lugar de fotos completas:** exigen orden estricto y conocer el estado previo; un evento perdido deja la copia mal para siempre.

## 4. Consecuencias

### Positivas

- servers puede estar caído sin impedir que los usuarios se unan a voz.
- Sale una petición de red del camino de ingreso: quedan lecturas locales y la emisión del token.
- voice-sfu sigue el mismo criterio que messaging y notifications: mismas fotos, mismo cálculo de permisos y mismo backfill.
- Los eventos que consume voice-sfu dejan de vivir en memoria: pasan a una base y sobreviven a un reinicio. No hay estado por instancia.

### Negativas y riesgos conocidos

1. **Consistencia eventual.** Un cambio de permisos tarda el poller de servers (unos 2 s) más la entrega. En ese lapso se aplica la regla anterior, así que alguien recién expulsado podría obtener un token. Si ya estaba conectado, el corte por acceso revocado lo saca de la sala.
1. **La regla de permisos queda escrita varias veces:** en Go en servers y en Elixir en messaging, notifications y voice-sfu. Un cambio en servers obliga a actualizar todas las copias y sus pruebas.
1. **Un canal o un miembro recién creados** no existen para voice-sfu hasta que llegan sus eventos. Unirse en esos segundos devuelve 403.
1. **Datos ausentes se leen como no permitido.** Un backfill incompleto produce 403, no errores de otro servicio.
1. **voice-sfu** **pasa a depender de una base propia:** hay que operarla (conexión, credenciales, respaldo) en el entorno donde corre el servicio.
