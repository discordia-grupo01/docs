# ADR-014: Autenticación del WebSocket de `messaging` con tickets de un solo uso

**Estado:** Aceptado

## Contexto

`messaging` entrega mensajes en tiempo real por WebSocket (Phoenix Channels). Hay que saber **quién** abre cada conexión, y hay tres restricciones:

1. **La API de WebSocket del navegador no permite mandar cabeceras propias** (como `Authorization`) en el handshake. Lo único que el cliente controla es la URL.

2. **El `web-client` no puede leer el JWT.** Según el equipo del `web-client`, el JWT vive en una cookie `httpOnly`, que el JavaScript del navegador no puede leer. Armar una URL con el JWT directamente no es ni posible.

3. **La autenticación del resto de la API la hace Kong.** El gateway valida la firma y el vencimiento del JWT en cada ruta REST, y `messaging` confía en eso: no verifica la firma, solo toma el `sub` del token. La ruta `/socket` de Kong no tiene el plugin de JWT, porque el handshake no trae el token.

Además, `messaging` necesita el JWT **del usuario** durante la conexión: lo reenvía como `Authorization: Bearer` a `servers` (para consultar permisos) y a `identify-service` (para validar a un destinatario).

El requisito no funcional de protección de datos pide que el acceso a datos de otros usuarios esté controlado por autorización explícita en cada operación y que los datos sensibles no se expongan.

## Decisión

Un **ticket de un solo uso, de 30 segundos de vida**, que se pide por REST con el JWT normal y se usa en la URL del WebSocket.

**Detalles de la implementación** (`Messaging.Auth.SocketTicket`, `TicketStore.Mongo`):

- **El ticket** son 32 bytes aleatorios de `:crypto.strong_rand_bytes` (256 bits), en base64 seguro para URL (43 caracteres). No contiene el JWT ni ninguna información: es un valor opaco.

- **En reposo se guarda su hash.** El `_id` del documento es el SHA-256 del ticket, así que quien lea la base no puede reconstruir un ticket.

- **Un solo uso.** Se canjea con `find_one_and_delete`, que es atómico: de dos conexiones simultáneas con el mismo ticket, una gana y la otra lo encuentra vacío.

- **30 segundos.** Al canjear se comprueba `expires_at` explícitamente. Además hay un índice TTL de Mongo (`expireAfterSeconds: 0`) que limpia los vencidos; como el monitor de Mongo corre aproximadamente cada minuto, la comprobación explícita es la que garantiza el límite.

- **La identidad sale del servidor.** El `user_id` se toma del JWT que Kong ya validó al emitir el ticket y se guarda junto al ticket; el cliente no puede elegirlo.

- **Compartido entre instancias.** Está en Mongo, no en memoria: una instancia puede emitir el ticket y otra canjearlo.

- **Sin ticket válido no hay conexión.** El handshake responde 403.

- **El `check_origin` de Phoenix** limita desde qué orígenes se aceptan conexiones (variable `CHECK_ORIGIN`).

## Consecuencias

- **Positivas:**
    - - El JWT **nunca** viaja en la URL.
    - - Un ticket robado (de un log, del historial) es inútil después de usarse o de 30 segundos.
    - - El emisor de tickets pasa por Kong: sin JWT válido no se obtiene un ticket (401).
    - - Funciona igual para el `web-client` y para otros clientes, y entre varias instancias de `messaging`.
    - - No requiere cambios en `servers` ni en `identify-service`.
- **Negativas:**
    - **El documento del ticket guarda el JWT en claro** (`raw_jwt`), desde que se emite hasta que se canjea (o hasta que Mongo lo limpia, que puede tardar alrededor de un minuto). El hash protege el ticket, **no** el JWT que está guardado al lado. Hace falta porque `messaging` llama a otros servicios en nombre del usuario. La exposición está acotada por los 30 segundos y por el borrado al canjear. *Alternativa a evaluar:* que `messaging` use una credencial de servicio y mande el id del usuario como dato, en vez de reenviar su JWT.
    - **Conectarse cuesta una petición REST más** y una escritura y un borrado en Mongo por conexión. Reconectar también exige un ticket nuevo.
    - **Depende de Mongo.** Si Mongo no responde no se pueden emitir ni canjear tickets (el emisor devuelve `503 TICKET_UNAVAILABLE`); las conexiones ya abiertas no se ven afectadas.
