# ADR-014: Autenticación del WebSocket de `messaging` con tickets de un solo uso

**Estado:** Aceptado
**Servicios:** `messaging`, `gateway` (Kong), `web-client`, `app-mobile`
**Relacionadas:** ADR-006 (API Gateway), ADR-017 (réplica local de permisos)

## Contexto

`messaging` entrega los mensajes en tiempo real por WebSocket, con Phoenix Channels, y necesita saber quién abre cada conexión. Tres cosas complican la tarea. La API de WebSocket del navegador no permite mandar cabeceras propias en el handshake, así que no se puede usar `Authorization`, y lo único que controla el cliente es la URL. Además, el `web-client` guarda el JWT en una cookie `httpOnly` que el JavaScript no puede leer, de modo que ni siquiera podría ponerlo en la URL aunque quisiera. Y la autenticación del resto de la API la hace Kong, que valida la firma y el vencimiento en cada ruta REST, mientras `messaging` confía en eso y solo toma el `sub` del token; la ruta `/socket` de Kong no puede llevar el plugin de JWT porque el handshake no trae el token.

El requisito de protección de datos pide que el acceso a datos ajenos esté controlado por una autorización explícita en cada operación y que los datos sensibles no se expongan.

## Decisión

Usamos un ticket de un solo uso, de 30 segundos de vida. El cliente lo pide por REST con su JWT normal, a través de Kong, y lo pone en la URL del WebSocket.

El ticket son 32 bytes aleatorios generados con `:crypto.strong_rand_bytes`, en base64 seguro para URL. Es un valor opaco: no contiene el JWT ni ninguna información. En la base se guarda solo su hash SHA-256, así que quien lea la base no puede reconstruir un ticket. Se canjea con un `find_one_and_delete` atómico, de modo que si dos conexiones simultáneas usan el mismo ticket, una gana y la otra no encuentra nada. Al canjear se comprueba explícitamente que no haya vencido, y además hay un índice TTL de Mongo que limpia los vencidos; como el monitor de Mongo corre más o menos cada minuto, la comprobación explícita es la que garantiza el límite de 30 segundos.

La identidad sale del servidor: el `user_id` se toma del JWT que Kong ya validó al emitir el ticket y se guarda junto con él, de manera que el cliente no puede elegirlo. El ticket vive en Mongo y no en memoria, así que una instancia de `messaging` puede emitirlo y otra canjearlo. Sin un ticket válido, el handshake responde 403. Y `check_origin` de Phoenix limita desde qué orígenes se aceptan conexiones, con la variable `CHECK_ORIGIN`.

## Alternativas descartadas

- **Mandar el JWT en la URL del WebSocket.** Queda en los logs, en el historial y en cualquier proxy, y el `web-client` no puede leerlo de todos modos.
- **Mandar el JWT como primer mensaje después de conectar.** Permitiría abrir la conexión sin identidad y autenticar después, con una ventana en la que hay un socket abierto de alguien desconocido.
- **Usar la cookie de sesión en el handshake.** Funciona en el navegador, pero no en la app móvil, y ata el WebSocket a un mecanismo de cookies cross-origin delicado.
- **Un ticket firmado y sin estado, tipo JWT de corta vida.** No necesita base, pero no se puede hacer de un solo uso sin guardar algo, y entonces no ganamos nada.

## Consecuencias

El JWT nunca viaja en la URL, y un ticket robado de un log o del historial es inútil después de usarse o pasados los 30 segundos. Obtener un ticket exige pasar por Kong con un JWT válido, el mecanismo funciona igual para el `web-client` y para otros clientes, y no requirió cambios en `servers` ni en `identify-service`.

Tiene costos. Conectarse cuesta un pedido REST más y una escritura y un borrado en Mongo por conexión, y reconectar también exige pedir un ticket nuevo. Además depende de Mongo: si no responde, no se pueden emitir ni canjear tickets (el emisor devuelve `503 TICKET_UNAVAILABLE`), aunque las conexiones ya abiertas no se ven afectadas.

Al principio había una debilidad: `messaging` necesitaba el JWT del usuario para llamar a otros servicios en su nombre, así que el ticket lo guardaba en claro, acotado por los 30 segundos. Eso quedó resuelto cuando `messaging` pasó a decidir permisos con una réplica local (ADR-017): hoy el ticket guarda solo el `user_id`.
