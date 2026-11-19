# ADR-039: Boostear un servidor es una saga por eventos entre `billing` y `servers`

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `billing`, `servers`, `events-contract`, `web-client`, `app-mobile`
**Relacionadas:** ADR-018 y ADR-030 (outbox y entrega de eventos), ADR-032 (avisos de cambio), ADR-038 (monetización), ADR-041 (eventos firmados)

## Contexto

Un usuario gasta puntos para boostear un servidor. Los boosts se acumulan y fijan el nivel del servidor: 5 boosts dan el nivel 1, 15 el nivel 2 y 30 el nivel 3. Retirar un boost no devuelve los puntos.

La operación cruza dos servicios con bases separadas. Los puntos son de `billing`. El servidor, sus miembros, su suspensión y su nivel son de `servers`. Para aceptar un boost hay que cumplir reglas de los dos lados: el usuario tiene que tener saldo, y el servidor tiene que existir, no estar suspendido, tener al usuario como miembro y no haber llegado al último nivel. No hay una transacción que abarque las dos bases.

La consigna pide elegir y documentar una estrategia de consistencia para estos flujos, y nombra este caso: aplicar un boost dos veces sería un error grave. Tampoco se puede perder un boost pagado ni devolver puntos de uno que quedó aplicado.

## Decisión

Es una saga coreografiada por eventos, sin orquestador. Cada paso es una transacción local que escribe su evento en el outbox de su servicio (ADR-018), y cada boost tiene un `boost_id` que lo identifica en los dos lados.

**1. Reservar (en `billing`).** `POST /v1/billing/boosts` descuenta 100 puntos, crea el boost en estado `pending` y anota `billing.server_boost_requested`, todo en la misma transacción. Si no alcanza el saldo, responde 409 `INSUFFICIENT_POINTS` y no crea nada. El pedido acepta un `Idempotency-Key`: si se repite, devuelve el mismo boost en vez de cobrar otra vez. La respuesta es `pending`, y el cliente consulta `GET /v1/billing/boosts/{id}` hasta que cambie.

**2. Decidir (en `servers`).** `servers` consume el pedido y bloquea la fila del servidor, así dos boosts del mismo servidor no se cuentan a la vez y dos pedidos con el servidor a un boost del tope no pueden entrar los dos. Si se cumplen las reglas, suma el boost y publica `servers.server_boost_applied`. Si no, lo rechaza con un motivo de negocio (`server_not_found`, `server_suspended`, `not_a_member`, `max_level_reached` o `cancelled`) y publica `servers.server_boost_rejected`. La respuesta y el contador se guardan en la misma transacción. Si el mismo pedido vuelve a llegar, `servers` repite la respuesta de la primera vez sin volver a contar.

**3. Cerrar (en `billing`).** Si el boost se aplicó, queda `active`. Si se rechazó, queda `failed` y los puntos se devuelven en la misma transacción. Solo cambia un boost que sigue `pending`, y la devolución se anota en el libro de movimientos con `UNIQUE(reason, ref_id)`, así que no se puede devolver dos veces.

**Si `servers` no contesta.** Cada 5 minutos, `billing` vuelve a publicar el pedido de los boosts que siguen pendientes, por si el evento se perdió. Como `servers` repite su respuesta, eso no tiene costo. Si a las 24 horas sigue sin respuesta, `billing` da el boost por fallido (`no_response`), devuelve los puntos y publica `billing.server_boost_cancelled`. Si `servers` ya lo había contado, deja de contarlo. Si el pedido llega después, lo rechaza con `cancelled`. Así el boost nunca queda cobrado sin aplicar ni aplicado sin cobrar.

**Retirar.** El usuario puede retirar un boost `active` con `DELETE /v1/billing/boosts/{id}`. Queda `removed`, no se devuelven puntos, como pide la consigna, y `billing.server_boost_removed` hace que `servers` lo descuente. Si se borra el servidor, `billing` marca sus boosts activos como retirados, también sin devolver puntos.

**Un fallo técnico nunca rechaza un boost.** Los consumidores de los dos lados solo descartan un evento que no puede funcionar nunca: un JSON roto, una firma inválida o una routing key desconocida. Si falla la base, el evento vuelve a la cola y se reintenta (ADR-030). Rechazar por un error técnico devolvería los puntos de un boost que quizás ya se aplicó.

**Los cinco pasos van firmados.** Un rechazo falso regalaría puntos y un pedido falso regalaría boosts, así que `billing` y `servers` firman y verifican cada paso con un secreto compartido (ADR-041). Además, `servers.server_boost_updated`, que no va firmado, avisa al resto el nuevo nivel del servidor. Los clientes se actualizan con el aviso de cambio de la ADR-032.

Un boost cuesta 100 puntos, el mismo precio que el paquete más chico (ADR-038). El tope son 30 boosts activos por servidor: en el nivel 3 un boost más no suma nada, así que se rechaza hasta que alguien retire uno.

## Alternativas descartadas

- **Que `billing` llame a `servers` por HTTP para validar y aplicar.** Es más simple de leer, pero con `servers` caído nadie podría boostear, y si la llamada falla después de aplicar el boost, `billing` no sabe si cobrar o devolver. La consigna pide justificar cada llamada síncrona entre servicios, y acá no hacía falta.
- **Que `billing` valide con una copia local de miembros y suspensiones.** Ahorra un paso, pero la decisión final depende del contador del servidor, que solo `servers` conoce. Dos boosts en paralelo podrían pasar el tope.
- **Un orquestador o un motor de sagas.** Para dos participantes y tres pasos es más infraestructura que problema, y sería otro servicio más que desplegar en planes gratuitos.
- **Two-phase commit entre las dos bases.** Bloquea las dos bases mientras espera, no lo soporta el broker y deja todo trabado si un participante cae a mitad de camino.
- **Cobrar recién cuando `servers` acepte.** Entre la aceptación y el cobro el usuario puede gastar el saldo en otro boost, y habría que deshacer un boost ya aplicado. Reservar primero hace que la única compensación posible sea devolver puntos, que es fácil e idempotente.

## Consecuencias

El boost no es inmediato: queda pendiente unos segundos hasta que `servers` responde, y el cliente lo muestra así mientras consulta el estado. Con RabbitMQ o `servers` caídos, el boost puede quedar pendiente hasta 24 horas antes de devolverse los puntos. Es una espera larga, pero nunca deja al usuario sin sus puntos ni al servidor con un boost sin pagar.

Cada paso se puede repetir sin efectos. Eso permite que los dos lados reintenten sin coordinarse, y que varias instancias de `billing` corran los jobs a la vez: toman las filas con `FOR UPDATE SKIP LOCKED`.

Hay un caso que se acepta. Si `servers` aplica el boost justo después de que `billing` lo cancela a las 24 horas, el evento `cancelled` hace que `servers` lo descuente. Durante ese rato, el servidor puede mostrar un boost de más.

El estado de un boost vive en dos bases, así que para seguir uno de punta a punta hay que mirar las dos. El `boost_id` es el mismo en las dos, y el id de traza viaja en los eventos (ADR-023).
