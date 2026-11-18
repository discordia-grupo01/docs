# ADR-022: servers: reportes de mensajes y usuarios que revisan los moderadores del servidor

**Estado:** Aceptada
**Fecha:** 2026-11-04
**Servicios:** `servers` (migración `0029_reports` y tres endpoints nuevos)
**Relacionadas:** historias de moderación del servidor (baneos, expulsión, filtro de palabras), ADR-017

## Contexto

La historia dice: "como miembro de un servidor, quiero reportar un mensaje o un usuario para alertar a los moderadores". El texto deja abiertas dos cosas.

La primera es a quién va el reporte. Habla de los usuarios con permisos de moderación del servidor, o sea de los moderadores de cada servidor y no del staff de la plataforma, que tiene sus propias historias en `admin` y `backoffice`: suspender y eliminar servidores, auditoría y expediente. La segunda es qué es un permiso de moderación, porque en nuestro catálogo no existe uno con ese nombre. Los que moderan de verdad son `MANAGE_MESSAGES` (borrar mensajes), `KICK_MEMBERS` y `BAN_MEMBERS`.

A eso se suma que el contenido de los mensajes es de `messaging`, mientras que los miembros, los roles y los permisos son de `servers`.

## Decisión

Los reportes viven en `servers`, en una tabla `reports`, y consideramos moderador a quien tiene a la vez `MANAGE_MESSAGES`, `KICK_MEMBERS` y `BAN_MEMBERS`; el dueño y los administradores los tienen implícitos. Quien tiene solo uno o dos no ve los reportes. Lo elegimos así porque un reporte puede terminar en borrar el mensaje, expulsar o banear, y el revisor tiene que poder hacer cualquiera de las tres cosas sin pasarle el caso a otro, y además la regla se explica en una frase. Está implementada en un solo lugar (`role.ModeratorPermissions` y `service.RequireModerator`), así que cambiarla, por ejemplo a "cualquiera de los tres", es tocar esa función. La consecuencia práctica es que si en un servidor nadie crea un rol con los tres permisos, los reportes solo los ven el dueño y los administradores.

Un reporte de mensaje guarda el canal y el id del mensaje, y uno de usuario guarda el id del reportado. Los dos llevan el servidor, quién reporta, el motivo, el estado y las fechas, y un `CHECK` impide filas incoherentes. No guardamos el contenido del mensaje ni su autor, que son de `messaging`, para minimizar datos; el moderador llega al mensaje por el canal y el id. Por lo mismo, `servers` no puede comprobar que el mensaje exista y solo valida el canal.

Un reporte nace `pending` y se cierra una sola vez como `resolved`, si el moderador actuó, o `dismissed`, si no había nada que hacer, con quién y cuándo. El caso del reporte duplicado lo decide la base de datos con dos índices únicos parciales sobre los pendientes, uno por servidor, quien reporta y mensaje, y otro por servidor, quien reporta y usuario; la violación se traduce en un `409 report_already_pending`. Un `SELECT` previo tendría una carrera, porque dos pedidos simultáneos pasarían los dos. Cuando se cierra el reporte anterior se puede volver a reportar, y otro miembro puede reportar lo mismo.

Al reportar se valida que quien reporta sea miembro, que el motivo exista, tenga hasta 512 caracteres y no tenga caracteres de control (el mismo límite que el motivo de un baneo), y, para un mensaje, que el canal sea de texto, del servidor y visible para quien reporta; si no lo ve, devuelve 404 como el resto de los endpoints de canales, para no revelar que existe. Para un usuario, tiene que ser miembro y no uno mismo; se puede reportar a cualquiera, el dueño incluido.

La API tiene tres rutas bajo `/v1/servers/{id}/reports`: un `POST` para que un miembro cree el reporte, un `GET` para que un moderador lo liste, del más nuevo al más viejo y filtrando por estado, y un `PATCH` para que un moderador lo cierre como `resolved` o `dismissed`, con `409 report_not_pending` si ya estaba cerrado. El `total` del listado cuenta los que tienen ese estado, así que pidiendo los pendientes con `limit=1` se sabe cuántos quedan por revisar sin bajar la lista. Cerrar un reporte no actúa sobre el mensaje ni sobre el usuario: para eso están los endpoints de moderación que ya existen.

No publicamos ningún evento. El aviso a los moderadores lo resuelve el front, con un punto cuando hay pendientes y una pantalla de reportes en la configuración del servidor. Si más adelante se quiere push, el camino es un evento `servers.report_created` que consuma `notifications` con la misma regla de moderador sobre sus réplicas de roles, pero hoy no tendría consumidor y no vamos a publicar un evento que nadie lee. Los reportes se borran con el servidor, y los de mensajes también con su canal. Si el reportado se va o lo echan, el reporte queda, porque es el registro de lo que pasó.

## Alternativas descartadas

Pensamos que moderador fuera quien tenga cualquiera de los tres permisos, pero se lo mostraríamos a gente que no puede actuar sobre el reporte; es reversible justamente porque la regla está en un solo lugar. Un permiso nuevo, del estilo `MODERATE` o `VIEW_REPORTS`, obligaba a tocar el catálogo, el bitmask, el `CHECK` de overrides por canal, los clientes y las réplicas de permisos de `messaging` y `notifications`, y no se justifica para una historia.

Que los vea el staff de la plataforma no corresponde, porque la historia habla de los moderadores del servidor. Guardar una copia del mensaje al reportar lo haría sobrevivir al borrado, pero duplica contenido que es de `messaging` y la historia no lo pide. Un modelo con un solo reporte por contenido y varios reportantes sería otro diseño, con un contador, y el caso del duplicado habla de lo que ya reportó ese miembro. Y mandar un evento y un push a los moderadores desde ya no tiene consumidor.

## Consecuencias

El diseño es simple y la regla de duplicados no tiene carreras, porque la decide la base. A cambio hay límites que aceptamos. El mensaje reportado puede no existir: un cliente puede mandar un `message_id` inventado en un canal real, y el moderador lo vería como un mensaje que no aparece; la mejora posible es validar contra `messaging` o guardar una copia. No hay límite de frecuencia, así que un miembro puede crear muchos reportes sobre mensajes distintos, porque el duplicado solo frena el mismo contenido.

Tampoco hay jerarquía: un moderador puede ser el reportado y ver el reporte sobre sí mismo, y se puede reportar al dueño, que es quien lo ve. Los reportes de mensajes de canales borrados desaparecen con el canal, aunque estuvieran pendientes. El listado se pagina por `offset`, igual que los baneos, con lo cual, si entran muchos reportes nuevos entre páginas, puede repetir o saltear alguno.

Quedan fuera de esta historia notificar a los moderadores, que el reportado se entere, los comentarios sobre el reporte y un historial de lo que se hizo, ya que la auditoría de moderación es otra historia.
