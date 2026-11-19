# ADR-041: Los eventos de `admin` y de `billing` van firmados con HMAC

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `admin`, `billing`, `servers`, `identify-service`, `messaging`, `voice-sfu`, `metrics`, `events-contract`
**Relacionadas:** ADR-007 (pub/sub), ADR-008 y ADR-031 (contrato de eventos), ADR-030 (entrega de eventos), ADR-034 (dónde corre cada servicio), ADR-038 (monetización), ADR-039 (saga de boosts), ADR-040 (login)

## Contexto

Los servicios se avisan los cambios por RabbitMQ (ADR-007), y cada consumidor aplica lo que recibe en su propia base. La mayoría de los eventos son de bajo riesgo: si alguien publicara un evento falso de mensaje leído, el daño sería mínimo. Pero hay eventos con un efecto grande, en los que un evento falso equivale a un permiso que nadie dio:

- `admin.user_suspended` deja a cualquiera afuera de su cuenta, y `admin.server_deletion_requested` borra un servidor para siempre.
- `admin.account_recovery_approved` le saca el segundo factor a una cuenta (ADR-040).
- `admin.staff_member_added` da acceso al backoffice.
- `billing.premium_updated` con `active: true` da Premium gratis.
- En la saga de boosts (ADR-039), un pedido falso da boosts sin pagar, y un rechazo falso devuelve puntos que nadie gastó.

RabbitMQ autentica a quien se conecta, pero no controla qué routing key publica cada cliente. Los servicios comparten el broker, y en la práctica varios usan las mismas credenciales (ADR-034). Cualquier proceso con acceso al broker, un servicio comprometido o un script olvidado con las credenciales, podría publicar un `admin.*` o un `billing.*`.

## Decisión

Los eventos con ese efecto llevan una firma HMAC-SHA256, y el consumidor descarta cualquier evento cuya firma no verifique. Son:

- **Todos los de `admin`:** suspensión y reactivación de cuentas y de servidores, pedido de borrado de un servidor, alta y baja de staff, y aprobación o rechazo de una recuperación de cuenta.
- **`billing.premium_updated`.**
- **Los cinco pasos de la saga de boosts:** `billing.server_boost_requested`, `billing.server_boost_cancelled`, `billing.server_boost_removed`, `servers.server_boost_applied` y `servers.server_boost_rejected`.

Hay dos secretos, uno por publicador. `ADMIN_EVENTS_HMAC_SECRET` lo tienen `admin`, que firma, y `identify-service`, `servers`, `messaging`, `voice-sfu` y `metrics`, que verifican. `BILLING_EVENTS_HMAC_SECRET` lo tienen `billing`, y `identify-service` y `messaging`, que verifican Premium. `servers` también lo tiene, porque firma y verifica los pasos de la saga. Así, un servicio que solo necesita saber de Premium no puede fabricar una suspensión, y al revés.

**Qué se firma.** No se firma el JSON tal cual llega, porque dos serializaciones del mismo evento pueden diferir en espacios u orden de campos. Se firma un texto canónico con los campos que importan, separados por saltos de línea:

- La routing key, para que un `user_suspended` válido no se pueda reenviar como `user_reactivated`, ni un evento de cuenta como uno de servidor.
- El `event_id`.
- Los ids de lo que el evento afecta: el usuario o el servidor en los eventos de `admin`, la solicitud y el usuario en una recuperación de cuenta, y el boost, el servidor, el usuario y el motivo en la saga.
- La versión del sujeto, en los eventos que la tienen (suspensiones, reactivaciones y Premium).
- La fecha del evento en UTC.
- En Premium, además, el estado, el vencimiento y si renueva.

La firma viaja en hexadecimal en el campo `signature`. Se compara en tiempo constante, y un secreto vacío o una firma vacía nunca verifican, así que un servicio mal configurado rechaza todo en vez de aceptar todo.

**Una sola implementación por lenguaje.** El texto canónico, `Sign` y `Verify` están en `events-contract`, en Go y en Elixir, con vectores de prueba compartidos (ADR-031). Si un lenguaje calcula distinto, el CI falla antes de que llegue a producción. Ningún servicio arma la firma a mano.

**Un evento con firma inválida es un fallo permanente.** Se confirma y se descarta sin reintentar, dejando constancia en el log (ADR-030), porque reintentarlo nunca lo va a hacer válido.

**La firma no evita las repeticiones; la versión sí.** Un evento auténtico capturado se podría volver a publicar tal cual. Eso no hace daño, porque procesar dos veces el mismo evento no cambia nada. En las suspensiones, reactivaciones y Premium, el consumidor solo aplica una versión mayor que la que ya tiene. En la saga, cada paso es idempotente por `boost_id`, y en una recuperación de cuenta solo se resuelve una solicitud que sigue pendiente.

## Alternativas descartadas

- **Usuarios de RabbitMQ por servicio, con permisos de tópico.** RabbitMQ puede limitar qué routing keys publica cada usuario, y es la solución de fondo para quién publica qué. Pero no protege si las credenciales de un servicio se filtran, y no cubre que un mensaje se modifique en el camino. Las dos medidas se complementan, y la firma era la que podíamos hacer en el código sin cambiar el despliegue del broker, que ya nos costó una caída (ADR-034).
- **Firmas asimétricas (Ed25519 o RSA).** Serían mejores: el consumidor tendría solo la clave pública y no podría fabricar eventos. Las descartamos por ahora porque suman manejo de pares de claves en Go y Elixir, y porque hoy cada secreto lo tienen solo servicios nuestros. Si se suma un consumidor de menos confianza, es el siguiente paso.
- **Mandar los eventos como JWT o JWS.** Es un formato estándar, pero cambia la forma de todos los mensajes, y el contrato y el AsyncAPI ya describen eventos JSON planos con sus campos.
- **Firmar todos los eventos.** Más uniforme, pero obliga a repartir secretos a todos los servicios por eventos cuyo engaño no da nada. Un `servers.server_deleted` falso, por ejemplo, puede marcar boosts como retirados, pero no regala puntos ni boosts.
- **No firmar y confiar en que el broker es privado.** Es lo que había al principio. Alcanza mientras nadie más tenga las credenciales, pero en un proyecto con el código público y varios entornos es una suposición frágil (ADR-033).

## Consecuencias

Un evento falso de `admin` o de `billing` no tiene efecto, aunque llegue por el broker correcto y con la routing key correcta. Cuando alguno se descarta, queda en el log.

Los secretos son simétricos, así que cualquier servicio que verifica también podría firmar. La protección es contra quien tiene acceso al broker pero no a esos secretos, no contra un servicio nuestro comprometido. Por eso cada secreto llega solo a los servicios que lo necesitan, y la mitigación de fondo es pasar a firmas asimétricas.

Rotar un secreto exige un despliegue coordinado: hay que cambiarlo a la vez en el publicador y en todos sus consumidores. Si no, los eventos de ese intervalo se descartan. Hoy no hay un período en que valgan dos secretos a la vez.

Agregar un campo al texto firmado rompe la compatibilidad con los consumidores viejos. Por eso se cambia en `events-contract` con una versión nueva y se actualizan todos los servicios juntos.
