# ADR-038: Monetización con Mercado Pago: Premium como suscripción, puntos como compra única y un webhook público firmado

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `billing`, `identify-service`, `messaging`, `web-client`, `app-mobile`
**Relacionadas:** ADR-001 (Go), ADR-018 y ADR-030 (outbox y entrega de eventos), ADR-037 (circuit breaker), ADR-039 (saga de boosts), ADR-041 (eventos firmados)

## Contexto

La épica de monetización tiene dos productos. El plan Premium es mensual: da adjuntos de hasta 50 MB, emojis animados y de cualquier servidor, y una insignia en el perfil. Si la renovación falla, la suscripción no se renueva y los beneficios se apagan; si el usuario cancela, los conserva hasta la fecha que ya pagó. Los puntos se compran una vez y se gastan en boosts de servidores (ADR-039). Las dos historias dependen de una "integración con pagos externos", así que hacía falta un proveedor real que cobre con tarjeta.

La consigna también pide que, si el pago se confirma pero el beneficio no se activa, el sistema revierta o compense el cobro. Y como se trata de plata, un error en cualquier sentido es grave: cobrar dos veces, acreditar dos veces o dar Premium gratis.

Además, el proveedor avisa el resultado de un pago desde afuera, por HTTP, y sin el JWT de un usuario. Hacía falta una ruta pública y una forma de saber que el aviso es auténtico.

## Decisión

**Proveedor: Mercado Pago, en pesos.** Todo el manejo de plata vive en un servicio propio, `billing`, en Go con su propia base PostgreSQL (ADR-001). Ningún otro servicio habla con Mercado Pago.

**Premium es una suscripción de Mercado Pago (`preapproval`).** Cuesta $4.999 por mes. El checkout crea una suscripción pendiente y devuelve la página de Mercado Pago donde el usuario carga la tarjeta. Premium empieza con el primer cobro aprobado, no al crear el checkout. Cada cobro aprobado extiende `premium_until` un mes desde donde estaba, sin huecos. Cancelar corta la renovación en Mercado Pago, pero el usuario conserva Premium hasta `premium_until`. Si una renovación falla, no se extiende nada, y cuando `premium_until` pasa, un job que corre cada minuto da Premium por terminado.

**Los puntos son una compra única (Checkout Pro, por la API de Orders).** Hay tres paquetes: 100 puntos por $1.000, 550 por $5.000 y 1.200 por $10.000. Un boost cuesta 100 puntos, es decir, lo mismo que el paquete más chico. Los precios están en un solo lugar del código, y cada compra guarda sus propios puntos y su monto, así que un cambio de precio solo afecta a las compras nuevas.

**El webhook es la única ruta pública de `billing`.** `POST /webhooks/mercadopago` no lleva JWT porque Mercado Pago no lo manda. Se protege con la firma `x-signature` que Mercado Pago calcula con un secreto compartido (`MP_WEBHOOK_SECRET`) sobre el id del recurso, el id del pedido y un timestamp. Si la firma no verifica, responde 401, y si el timestamp tiene más de 5 minutos lo trata como una repetición. El cuerpo no se usa para decidir nada: solo dice "cambió el recurso X". `billing` vuelve a pedir ese recurso a Mercado Pago y actúa según lo que le contesta. Así, aunque alguien consiguiera mandar un aviso con firma válida, no puede inventar un pago.

**Cada aviso se puede procesar cualquier cantidad de veces.** Una compra acredita sus puntos en un libro de movimientos con `UNIQUE(reason, ref_id)`, así que acreditarla dos veces es imposible. Un cobro de Premium se guarda por su id de Mercado Pago, que también es único. Si algo falla, el webhook responde 500 y Mercado Pago reintenta. Si el aviso apunta a un recurso que no corresponde, como otro monto o el pedido de otro usuario, se responde 200 y queda en el log para que lo revise una persona, porque reintentarlo no lo va a arreglar.

**No depender del webhook: jobs de conciliación.** Un aviso se puede perder, así que `billing` también pregunta. Cada 15 minutos revisa las compras de puntos pendientes y abandona las que nadie pagó en 24 horas. Cada hora revisa las compras pagadas de los últimos 180 días, por si llegó un contracargo cuyo aviso se perdió. Y cada hora sincroniza todas las suscripciones que todavía pueden cambiar. La página de retorno del cliente, además, pide el estado con `refresh`, que consulta a Mercado Pago en el momento.

**El cobro y el beneficio se escriben juntos.** El beneficio de una compra de puntos es el saldo, que vive en la misma base que el pago, y se acredita en la misma transacción que lo marca como pagado. Para Premium, `billing` guarda el cobro, extiende `premium_until` y anota el evento `billing.premium_updated` en su outbox en una sola transacción (ADR-018). Por eso no existe el caso de "pago confirmado y beneficio sin activar" dentro de `billing`. Lo que puede tardar es que `identify-service` y `messaging` se enteren, y el outbox garantiza que el evento sale apenas RabbitMQ vuelve. El evento es una foto completa con un número de versión, así que los consumidores lo aplican una sola vez y en orden (ADR-041).

**Compensaciones.**

- **Suscripción duplicada.** Si el usuario autoriza una segunda suscripción mientras otra sigue viva, por ejemplo pagando en dos pestañas, la nueva se cancela en Mercado Pago, y si llegó a cobrarse, el cobro se reembolsa automáticamente. Antes de un checkout nuevo se cancelan los anteriores que quedaron pendientes.
- **Doble clic.** Los checkouts aceptan un `Idempotency-Key`. Si llega repetido, se devuelve el mismo checkout en vez de crear otro cobro.
- **Reembolso o contracargo de Premium.** Premium termina en el acto y la suscripción se cancela en Mercado Pago.
- **Reembolso o contracargo de puntos.** Los puntos se descuentan. Si el usuario ya gastó una parte, el saldo nunca baja de cero, y lo que no se pudo recuperar queda registrado en la compra (`points_unrecovered`). Los reembolsos de puntos son siempre totales y se hacen desde el panel de Mercado Pago.

**Herramienta de prueba.** Mercado Pago no permite adelantar el tiempo ni hacer fallar una renovación a pedido. Para mostrar esos casos, con `BILLING_DEV_TOOLS=true` se habilita un simulador que ejecuta el mismo código que un cobro real o que el job de vencimiento. En producción está apagado.

## Alternativas descartadas

- **Stripe.** Tiene la mejor API y el mejor modo de prueba, pero no permite abrir una cuenta para cobrar desde Argentina, y el grupo no tiene una entidad en otro país.
- **PayPal.** No cobra en pesos, y entre los usuarios de acá es mucho menos común que Mercado Pago.
- **Simular los pagos sin un proveedor.** Es lo más simple, pero la historia pide integrar un medio de pago externo, y deja sin probar justamente lo difícil: avisos que llegan tarde, repetidos o nunca.
- **Premium como compra única de un mes, sin suscripción.** Evita el `preapproval`, pero obliga al usuario a pagar a mano todos los meses y no cumple la historia, que habla de renovación.
- **Confiar en el cuerpo del webhook.** Ahorra una llamada a Mercado Pago por aviso, pero haría que la seguridad dependa solo de la firma, que cubre el id del recurso y no el cuerpo. Además, los avisos pueden llegar desordenados, y lo único que siempre está al día es lo que responde Mercado Pago.
- **Proteger el webhook con una lista de IPs de Mercado Pago.** Mercado Pago no garantiza un rango fijo, y con Kong delante habría que confiar en la IP que reenvía el gateway. La firma no depende de la red.
- **Que cada servicio que da un beneficio le pregunte a `billing` en el momento.** Es una llamada síncrona por cada adjunto o perfil, y con `billing` caído nadie podría usar Premium. Preferimos que repliquen el estado por evento.

## Consecuencias

Los cobros, los saldos y los beneficios no se pueden duplicar, aunque Mercado Pago repita un aviso, lo pierda o lo mande en otro orden, porque todo es idempotente y los jobs de conciliación cubren lo que no llegó. El beneficio se activa en la misma transacción que el pago, así que la compensación solo hace falta en los casos que vienen de afuera (duplicados, reembolsos y contracargos), y está automatizada.

Hay costos. Dependemos de un proveedor externo con un sandbox limitado: Mercado Pago rechaza suscripciones cuyo pagador no sea el comprador de prueba, por eso en sandbox el email se reemplaza por uno configurado, y no se puede probar una renovación real sin esperar un mes. Las llamadas a Mercado Pago pasan por un circuit breaker (ADR-037), pero todavía no tienen trazas propias (ADR-023). El webhook es una ruta pública, así que el secreto de Mercado Pago es tan sensible como el JWT: si se filtra, hay que rotarlo en el panel y en la VM.

Los usuarios ven el estado de Premium y de sus puntos con unos segundos de demora respecto del pago, el tiempo que tarda en llegar el aviso o en que la página de retorno consulte. Mientras tanto, la página de retorno muestra que el pago está en proceso.
