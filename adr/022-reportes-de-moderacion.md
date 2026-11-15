# ADR-022: servers: reportes de mensajes y usuarios que revisan los moderadores del servidor

**Estado:** Aceptada  
**Fecha**: 2026-11-04  
**Servicios**: `servers` (migración `0029_reports`, tres endpoints nuevos), `gateway` (sin cambios: Kong ya enruta todo `/v1/servers`)  
**Decidida por**: Facundo Madotta (diseño, implementación y pruebas)  
**Historia**: "Reportar mensaje o usuario": CA1 reporte exitoso, CA2 reporte duplicado  
**Relacionadas**: Historias de moderación del servidor (baneo #25/#26, expulsión #59, filtro de palabras), ADR-017 (permisos como bits en `servers`)

## 1. Contexto

La historia dice: *"como miembro de un servidor, quiero reportar un mensaje o un usuario para alertar a los moderadores"*. Hay dos puntos que el texto deja abiertos:

- **A quién va el reporte.** Dice "los usuarios con permisos de moderación **del servidor**". Es de los moderadores de cada servidor, no del staff de la plataforma (`admin` y `backoffice` tienen sus propias historias: suspender y eliminar servidores, auditoría, expediente).
- **Qué es "permisos de moderación".** En el catálogo de permisos no existe uno llamado así. Los que moderan son `MANAGE_MESSAGES` (borrar mensajes), `KICK_MEMBERS` y `BAN_MEMBERS`.

Además, el contenido de los mensajes es de `messaging`; los miembros, los roles y los permisos son de `servers`.

## 2. Decisión

### 2.1 Moderador = los tres permisos juntos

Un **moderador** es quien tiene `MANAGE_MESSAGES`, `KICK_MEMBERS` y `BAN_MEMBERS` a la vez (el dueño y los administradores los tienen implícitos). Quien tiene solo uno o dos **no** ve los reportes.

Razón: un reporte puede terminar en borrar el mensaje, expulsar o banear, y el revisor tiene que poder hacer cualquiera de las tres cosas sin pasarle el caso a otro. Además la regla se explica en una frase.

Se implementa en un solo lugar: `role.ModeratorPermissions` y `service.RequireModerator`, que usa `Standing.Has` (con varios bits exige todos). Cambiar la regla, por ejemplo a "cualquiera de los tres", es tocar esa función.

Consecuencia: si en un servidor nadie crea un rol con los tres permisos, los reportes solo los ven el dueño y los administradores. Para la demo hay que crear un rol "Moderador" con los tres.

### 2.2 Dónde vive y qué guarda

En `servers`, tabla `reports`:

- **Reporte de mensaje**: `channel_id`, `message_id`
- **Reporte de usuario**: `reported_user_id`

Los dos llevan servidor, quien reporta, motivo, estado y fechas. Un `CHECK` impide filas incoherentes (un reporte de mensaje sin mensaje, uno de usuario con canal, uno cerrado sin quién ni cuándo).

**No se guarda el contenido del mensaje ni su autor**: son de `messaging` (minimización de datos). El moderador llega al mensaje por el canal y el id. Por lo mismo, `servers` **no puede comprobar que el mensaje exista**: valida el canal, no el mensaje.

### 2.3 Estados y reporte duplicado (CA2)

Un reporte nace `pending` y se cierra **una sola vez** como `resolved` (el moderador actuó) o `dismissed` (no había nada que hacer), con quién y cuándo.

El CA2 ("ya existe un reporte pendiente de su parte") lo decide **la base**, con dos índices únicos parciales (`WHERE status = 'pending'`): uno por `(servidor, quien reporta, mensaje)` y otro por `(servidor, quien reporta, usuario)`. La violación se traduce en `409 report_already_pending`. Un `SELECT` previo tendría una carrera: dos pedidos simultáneos pasarían los dos.

Cuando el reporte anterior se cierra, se puede volver a reportar. Otro miembro sí puede reportar lo mismo.

### 2.4 Qué se valida al reportar

- Quien reporta es **miembro** (403 si no).
- Motivo **obligatorio**, de hasta 512 caracteres, sin caracteres de control (mismo límite y saneado que el motivo de un baneo).
- Mensaje: el canal tiene que ser **de texto**, **del servidor** y **visible para quien reporta**. Si no lo ve, 404 (igual que el resto de los endpoints de canales: no revela que existe). Se reutiliza `RequireVisibleChannel`.
- Usuario: tiene que ser **miembro** y **no uno mismo**. Se puede reportar a cualquiera, el dueño incluido.

### 2.5 API

- **`POST /v1/servers/{id}/reports`**: Quién: miembro; Qué hace: Crea el reporte. 201
- **`GET /v1/servers/{id}/reports`**: Quién: moderador; Qué hace: Lista, más nuevo primero. `status`: `pending` (por defecto), `resolved`, `dismissed`, `all`
- **`PATCH /v1/servers/{id}/reports/{reportId}`**: Quién: moderador; Qué hace: Cierra: `resolved` o `dismissed`. 409 `report_not_pending` si ya estaba cerrado

`total` del listado es la cantidad **con ese estado**, así que `GET ...?status=pending&limit=1` devuelve cuántos hay por revisar sin bajar la lista. Cada reporte trae el perfil replicado de quien reportó y del reportado (`null` hasta que llega de identify).

Cerrar un reporte **no actúa** sobre el mensaje ni el usuario: para eso están los endpoints de moderación que ya existen.

### 2.6 Sin eventos ni push

No se publica ningún evento. El aviso a los moderadores lo resuelve el front: un punto cuando `total` pendiente es mayor que 0 y, en la configuración del servidor, la pantalla "Ver reportes" (lista y botones de resolver y descartar). El CA1 se cumple porque el reporte queda disponible para su revisión, no porque se le empuje a cada moderador.

Si más adelante se quiere push, el camino es un evento `servers.report_created` consumido por `notifications`, con la misma regla de moderador calculada sobre sus réplicas de roles. Hoy no hay consumidor, y no se publica un evento sin consumidor.

### 2.7 Borrado

Los reportes se borran con el servidor (`ON DELETE CASCADE`) y los de mensajes también con su canal. Si el reportado se va o lo echan, el reporte queda (es el registro de lo que pasó). Si el servidor está suspendido por la plataforma, el middleware ya rechaza todo con `SERVER_SUSPENDED`, reportes incluidos.

## 3. Alternativas descartadas

- **Moderador = cualquiera de los tres permisos**: Se lo mostraría a gente que no puede actuar sobre el reporte. Es reversible: la regla está en un solo lugar.
- **Un permiso nuevo (`MODERATE`, `VIEW_REPORTS`)**: Toca el catálogo y el bitmask, el `CHECK` de overrides por canal, los clientes y las réplicas de permisos de `messaging` y `notifications`, que reciben los permisos por nombre. No se justifica para esta historia.
- **Que los vea el staff de la plataforma**: La historia habla de los moderadores del servidor. El staff tiene sus propias historias.
- **Guardar una copia del mensaje al reportar**: Sobrevive al borrado, pero duplica contenido que es de `messaging`. La historia no lo pide.
- **Detectar el duplicado con un `SELECT` antes de insertar**: Carrera entre dos pedidos simultáneos; lo decide el índice único.
- **Un solo reporte por contenido con varios reportantes**: Es otro modelo (contador de reportes); el CA2 habla de lo que ya reportó **ese** miembro.
- **Evento y push a moderadores ya**: Sin consumidor. El aviso es del front.

## 4. Consecuencias y límites

- **El mensaje reportado puede no existir.** Un cliente puede mandar un `message_id` inventado en un canal real. El moderador lo vería como un mensaje que no aparece. Mejora posible: validar contra `messaging` o guardar una copia.
- **Sin límite de frecuencia.** Un miembro puede crear muchos reportes sobre mensajes distintos. El duplicado solo frena el mismo contenido.
- **Un moderador puede ser el reportado** y ver el reporte sobre sí mismo. Tampoco hay jerarquía: se puede reportar al dueño, y es el dueño quien lo ve.
- **Reportes de mensajes de canales borrados desaparecen** con el canal, aunque estuvieran pendientes.
- **Paginado por `offset`**, igual que los baneos; con muchos reportes nuevos entre páginas puede repetir o saltear alguno.
- **Fuera de alcance**: notificar a los moderadores, que el reportado se entere, comentarios sobre el reporte, historial de qué se hizo (la auditoría de moderación es otra historia).
