# ADR-020: notifications: indicadores de no leído derivados de eventos, sin llamadas HTTP entre servicios

**Estado:** Aceptada
**Fecha:** 2026-10-23
**Servicios:** `notifications`, `messaging`, `events-contract`, `gateway` (Kong), `infrastructure`
**Relacionadas:** ADR-014 (ticket del WebSocket), ADR-016 (propagación entre instancias), ADR-017 (réplica local de permisos)

## Contexto

La historia de usuario pide saber, por canal y por servidor, si hay algo sin leer, y distinguir las menciones. Para eso hacen falta tres datos que viven en lugares distintos: qué mensajes se escribieron (`messaging`), quién puede ver cada canal (`servers`, con sus miembros, roles, overrides y dueño) y hasta dónde leyó cada usuario, que todavía no guardaba nadie.

El repositorio `notifications` ya existía, vacío, con la plantilla. La indicación del equipo fue seguir el mismo alineamiento que `messaging` y, como es un servicio de eventos, no hacer pedidos HTTP entre servicios.

## Decisión

Todo lo que `notifications` sabe le llega por eventos. Consume de `discordia.events` con una cola durable propia, `notifications.unread_state`, y de ahí aprende la actividad y las menciones de los canales, qué canales existen, quién es miembro y desde cuándo, y los permisos. Los eventos de `servers` ya se publicaban, y con ellos arma una réplica local de permisos en Mongo, igual que en el ADR-017 y con el mismo cálculo que usa `messaging`. Así sabe qué canales de texto puede ver cada usuario sin preguntarle a `servers`.

Lo único que faltaba era que `messaging` avisara cuando se escribe un mensaje, porque hasta entonces solo notificaba a sus propios sockets. Agregamos el evento `messaging.message_created`, que sale por el mismo outbox que el resto (ADR-018), en la misma transacción que el mensaje. Lleva solamente ids (servidor, canal, mensaje, autor y mencionados) y la fecha, nunca el contenido: `notifications` no necesita saber qué se dijo. No se publica para mensajes directos, que no tienen servidor ni permisos por canal.

El estado se deriva comparando ids, sin contadores. Por canal se guarda el id del último mensaje, y por usuario y canal el id hasta donde leyó y el de la última mención. Como los ids son UUIDv7, que ordenan por tiempo, un canal está sin leer cuando su último mensaje es posterior al mayor entre lo leído y el momento en que el usuario entró al servidor, y una mención destaca de la misma manera. Todas las escrituras usan `$max`, de modo que solo avanzan. Eso hace que procesar un evento dos veces, o fuera de orden, deje el mismo estado, que es justo lo que necesita el "al menos una vez" de RabbitMQ, sin tablas de deduplicación para los mensajes. Los mensajes propios no encienden el canal y marcan como leído lo anterior, y quien entra a un servidor no ve todo el historial previo como pendiente. Una mención sigue destacada hasta que se lee el canal; un mensaje común posterior no la apaga.

Se entregan booleanos y no cantidades. La historia habla de un indicador, hay o no hay, y contar obligaría a guardar contadores o a contar en cada consulta, algo que nadie pidió.

El estado viaja por un canal Phoenix propio, `notifications:<user_id>`, en `/notifications/socket`. Al unirse el usuario recibe un `snapshot` con lo que tiene sin leer, y después un `unread_updated` solo cuando cambian los indicadores; el cliente manda `mark_read` al abrir un canal y `mark_all_read` para marcar todo. Como el navegador no puede mandar `Authorization` al abrir un WebSocket (ADR-014), repetimos el patrón de `messaging`: un ticket de un solo uso de 30 segundos, que se pide con `POST /v1/notifications/socket-tickets` y se guarda en Mongo. Es la única llamada HTTP del servicio y va del cliente hacia `notifications`, no entre servicios. Descartamos reutilizar el socket de `messaging` porque acoplaría la disponibilidad de los dos servicios y haría que `messaging` conociera un concepto que no es suyo.

Marcar todo como leído sube, para cada canal visible con algo pendiente, el marcador al último mensaje, en una sola escritura en bloque. Después se manda un `resync` a las sesiones del usuario, que reciben un `snapshot` vacío; así todas convergen al estado guardado sin repartir una notificación por canal.

El orden de los eventos de `servers` se resuelve como en `messaging`, con un reloj por entidad: gana el más nuevo por `occurred_at` y los borrados dejan una lápida de 7 días. Si un usuario que se había ido vuelve a entrar, su membresía cuenta como nueva, con su propio momento de ingreso.

`notifications` corre en una sola instancia, por decisión del equipo, así que no hay fanout entre instancias ni colas por instancia. La regla de que nada importante viva en memoria se mantiene: el estado está en Mongo y cada socket guarda solo una copia de trabajo de su usuario, que se reconstruye con un `resync`.

Para arrancar sobre datos existentes hubo que resolver que la cola nace vacía y RabbitMQ no guarda lo publicado antes. El backfill de `servers` re-publica roles, miembros, overrides y dueño, pero no los canales, y para no pedir un cambio a `servers`, un `messaging.message_created` de un canal desconocido lo da de alta como canal de texto, salvo que figure borrado. La línea base de cada miembro es el momento en que el servicio lo vio por primera vez, así que el historial anterior al despliegue no aparece como no leído.

## Alternativas descartadas

La primera idea, consultar por HTTP a `messaging` y a `servers`, era justamente lo que se pidió evitar, porque acopla la disponibilidad de los tres servicios y multiplica la latencia del `snapshot`.

Los contadores de no leídos se desincronizan ante reentregas o fallos parciales, y la historia ni siquiera pide números. Tampoco pusimos lo no leído dentro de `messaging`, porque mezcla responsabilidades y el repositorio de `notifications` estaba para esto. Publicar el contenido del mensaje en el evento es innecesario y expone datos de más en el bus, y el polling del cliente no tiene sentido cuando la historia es de tiempo real y ya había infraestructura de WebSocket.

## Consecuencias

El servicio no depende de ningún otro en el camino de lectura y escritura: si `messaging` o `servers` se caen, los indicadores siguen respondiendo con lo último que supieron. A cambio, todo lo que muestra es consistente solo con el tiempo, lo que tardan los eventos en llegar.

Hay límites que aceptamos. El orden depende de los relojes de las instancias de `messaging`, que generan los UUIDv7, así que entre mensajes concurrentes puede haber un desfase de milisegundos, el mismo que ya tiene el historial. `mark_read` acepta ids que todavía no llegaron a `notifications`, porque el cliente ve el mensaje en vivo por `messaging` antes de que `notifications` procese su evento y, si se recortara al último mensaje conocido, el canal se encendería justo después de leerlo; se acepta cualquier UUIDv7 que no esté más de 60 segundos en el futuro, y el peor caso de un id mal puesto es que el propio usuario se oculte sus avisos.

Quedaron fuera de esta decisión la suspensión de usuarios, los mensajes directos, las menciones agregadas al editar un mensaje y los conteos. El push al celular y el centro de notificaciones vinieron después, en el ADR-021. Y el tratamiento de un evento que falla una y otra vez, que al principio se reintentaba indefinidamente, se resolvió luego con la cola de eventos muertos del ADR-030.
