# ADR-032: Avisos de cambio en tiempo real sin datos, para que los clientes se actualicen sin recargar

**Estado:** Aceptada
**Fecha:** 2026-11-11
**Servicios:** `notifications`, `servers`, `billing`, `admin`, `events-contract`, `client-shared`, `web-client`, `app-mobile`, `backoffice`
**Relacionadas:** ADR-020 (no leídos por eventos), ADR-030 (entrega de eventos), ADR-031 (contrato de eventos)

## Contexto

La consigna pide tiempo real sin recargar, y hasta entonces solo los mensajes y los indicadores de no leído se actualizaban solos. Los demás cambios, como que alguien entre a un servidor o salga, que cambien los roles o los canales, que alguien cambie su foto de perfil, que se borre un servidor, que llegue una transferencia, que cambien los puntos o las métricas, solo se veían al recargar o al volver a abrir una pantalla.

Había dos formas obvias de hacerlo y ninguna nos convencía del todo. Empujar los datos nuevos a cada cliente obligaba a que el servicio que los empuja conociera los permisos de cada destinatario, para no mostrarle a nadie lo que no puede ver, y a que todos los formatos viajaran por otro canal. Y pedirle a cada pantalla que consulte cada pocos segundos gasta pedidos y sigue sin ser inmediato.

## Decisión

Los servicios que cambian los datos publican un evento corto, sin firma y sin datos, que solo dice qué cambió: `servers.resource_changed`, `billing.account_changed` y `admin.backoffice_changed`. `notifications` los consume y los empuja a los clientes como un aviso `changed` con el recurso afectado (y, si corresponde, el servidor o el usuario) por el WebSocket que ya tiene con cada usuario, a los temas `server:<id>` y `user:<id>`. Cuando un cliente recibe el aviso, vuelve a pedir lo que necesita por REST, con su propio permiso, así que lo que ve sigue dependiendo de la API y no del aviso.

Elegimos alojar el empuje en `notifications`, que ya mantiene los WebSockets de los usuarios y que se mantiene despierto en su hosting por el aviso periódico a `/health`. Cada cliente además refresca cada 30 segundos como red de seguridad, para el caso de que se pierda un aviso o el WebSocket no esté conectado.

En `client-shared` quedó la parte común, con un bus de cambios, un coalescedor que junta varios avisos seguidos en un solo refresco y las funciones para suscribirse a un recurso o al perfil de un usuario, y cada aplicación (web, móvil y backoffice) lo usa con un hook que vuelve a pedir los datos cuando llega un aviso. Para sumar un recurso nuevo alcanza con agregar un aviso en `Notifications.Realtime` y el hook en la pantalla.

## Alternativas descartadas

- **Empujar los datos nuevos por el WebSocket.** Habría que repetir en `notifications` los permisos y los formatos de cada recurso, o dejar que muestre datos que el destinatario no debería ver.
- **Que cada pantalla consulte cada pocos segundos, sin avisos.** Es lo más simple, pero gasta pedidos aunque no cambie nada y los cambios siguen sin ser inmediatos; lo dejamos como red de seguridad cada 30 segundos.
- **Reutilizar el WebSocket de `messaging`.** Acoplaría la disponibilidad del chat con la de las pantallas de configuración y daría a `messaging` responsabilidades que no son suyas.
- **Server-Sent Events o un servicio de terceros.** Sumaría una tecnología o un proveedor más, cuando ya teníamos un WebSocket con tickets y reconexión resuelto.

## Consecuencias

Las pantallas se actualizan al instante sin que ningún servicio tenga que conocer los permisos de los destinatarios, y como el aviso no lleva datos, no hay forma de que filtre algo que alguien no puede ver ni hay que firmarlo. No tocamos los permisos ni los formatos de los eventos existentes.

El costo es un pedido REST extra por cada aviso, que el coalescedor reduce cuando llegan varios juntos, y que `notifications` pasa a ser parte del camino de cualquier actualización en vivo; si cae, las pantallas siguen funcionando con el refresco de 30 segundos. Además, con más cambios pueden llegar más avisos de los necesarios, porque el aviso dice qué recurso cambió pero no qué parte, así que algunos pedidos traen datos que no cambiaron.
