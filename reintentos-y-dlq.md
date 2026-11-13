# Reintentos y cola de eventos fallidos (DLQ)

Qué hace cada servicio cuando un evento que consume no se puede procesar, y cómo se revisa lo que queda apartado.

## El problema

Antes, un evento válido que fallaba siempre (por ejemplo, la base no respondía o el evento hacía fallar al consumidor) se devolvía a la cola con `nack requeue` sin límite. Se reintentaba para siempre, frenaba a los eventos que venían detrás y no dejaba más rastro que los logs. En `voice-sfu` y en `metrics` ni siquiera esperaba entre intentos.

## La política

Es la misma en todos los servicios que consumen colas.

| Pieza | Valor |
|---|---|
| Intentos | 5 en total |
| Espera entre intentos | 1 s, 2 s, 4 s y 8 s (el doble cada vez, con tope de 30 s) |
| Variación al azar (*jitter*) | ±20 % sobre cada espera, para que varias instancias no reintenten a la vez |
| Tiempo máximo hasta apartarlo | unos 15 s |
| Al fallar el 5.º intento | se publica a `<cola>.dlq` y recién entonces se confirma (`ack`) el original |
| Si la publicación a la DLQ falla | no se confirma el original: sigue en su cola y se reintenta, así que no se pierde |

La cuenta de intentos se lleva en memoria del consumidor, por evento (una huella del `routing key` y el cuerpo). Se eligió así para no tocar las colas existentes: RabbitMQ no permite cambiar los argumentos de una cola ya creada, y usar *dead-letter exchange* nativo obligaba a borrar y recrear las colas en producción. Si el servicio se reinicia, la cuenta vuelve a cero: el evento tiene otros 5 intentos, lo cual es inocuo porque los consumidores son idempotentes.

## Qué se reintenta y qué no

Cada consumidor ya separaba los dos casos antes de este cambio; la DLQ solo actúa sobre el primero. El detalle y los ejemplos están en `fallos-transitorios-vs-permanentes.md` (en la raíz del proyecto).

- **Transitorio** (la base, LiveKit o los sockets no responden): se reintenta con espera creciente y, si agota los 5 intentos, va a la DLQ.
- **Permanente** (JSON roto, campos inválidos, firma HMAC mala, routing key desconocida): se confirma y se descarta sin reintentar. Queda en el log o, donde existe, en la auditoría (`consumed_events`). **No** pasa por la DLQ.
- **Duplicado o viejo**: no es un error. Se ignora.

## Dónde se aplica

| Servicio | Colas con DLQ |
|---|---|
| `messaging` | `messaging.channel_lifecycle`, `messaging.admin_events`, `messaging.billing_events`, `messaging.server_emojis`, `messaging.server_boosts` |
| `notifications` | `notifications.unread_state` |
| `servers` | `servers.admin_events`, `servers.user_profiles`, `servers.billing_events` |
| `identify-service` | `identify.server_memberships`, `identify.admin_events`, `identify.billing_events` |
| `billing` | `billing.servers_events` |
| `admin` | `admin.users`, `admin.servers`, `admin.activity` |
| `metrics` | `metrics` (el nombre sale de `EVENTS_QUEUE`) |
| `voice-sfu` | la cola de comandos (`voice.signaling.<instance_id>.commands`), la réplica (`voice.signaling.<instance_id>.replica`) y la de suspensiones (`voice.signaling.<instance_id>.suspensions`) |

Quedan afuera, a propósito, las colas efímeras de cada instancia: `messaging.broadcast.<uuid>` y la de presencia de `voice-sfu`. Siempre confirman el mensaje, expiran solas (5 y 10 minutos) y perder un aviso en vivo se compensa leyendo el historial. No hay nada que apartar.

## Cómo es la DLQ

- Exchange `discordia.dlx`, de tipo *direct* y durable.
- Una cola `<cola>.dlq` por cada cola de origen, enlazada con la clave `<cola>`. Son colas nuevas: no cambia nada de las existentes.
- El mensaje conserva el cuerpo original y es persistente. Lleva estos headers:

| Header | Contenido |
|---|---|
| `x-original-queue` | cola de la que vino |
| `x-original-exchange` | exchange original (`discordia.events`) |
| `x-original-routing-key` | routing key original |
| `x-event-id` | `event_id` del cuerpo, si lo tiene |
| `x-attempts` | cantidad de intentos (5) |
| `x-failure-reason` | `retries_exhausted` |
| `x-failed-at` | fecha y hora en UTC |

El error de cada intento no viaja en los headers: queda en el log del servicio. Los servicios en Elixir (`messaging`, `notifications`, `voice-sfu`) escriben `event_attempt_failed` (con `event_id` e intento) y, al apartar el evento, `event_moved_to_dead_letter_queue`; el motivo está en la línea `..._event_failed` inmediatamente anterior. Los servicios en Go escriben `deadletter: ... attempt N failed` y `deadletter: ... moved to <cola>.dlq`, con el `event_id` en la misma línea.

## Cómo revisar y reinyectar un evento

1. **Mirar si hay algo.** En la interfaz de administración de RabbitMQ, ver si alguna cola `*.dlq` tiene mensajes. Es la señal de que algo falló de forma persistente.
2. **Leerlo sin sacarlo.** En la cola, *Get messages* con *Ack mode* en "Nack message requeue true". Mirar `x-event-id`, `x-original-routing-key` y el cuerpo.
3. **Buscar la causa.** Buscar en el log del servicio el `event_id` y leer el error que aparece junto a cada intento.
4. **Arreglar la causa** (por ejemplo, restaurar la base o completar un backfill).
5. **Reinyectarlo.** Publicar el mismo cuerpo en el exchange por defecto (*AMQP default*) con routing key igual a la cola de origen (`x-original-queue`). Así llega solo a esa cola y no a las demás que escuchan el mismo evento. Los consumidores son idempotentes, así que repetir un evento ya aplicado es inofensivo.
6. **Sacarlo de la DLQ**: *Get messages* con "Reject requeue false" sobre ese mismo mensaje.

Si el evento sigue fallando después de reinyectarlo, vuelve a hacer 5 intentos y regresa a la DLQ.

## Qué no cubre

- No hay una alerta cuando la DLQ tiene mensajes; hoy se revisa a mano (está anotado en la sección de monitoreo de la checklist).
- La cuenta de intentos es por proceso: con varias instancias de un mismo consumidor, un evento puede sumar más de 5 intentos entre todas antes de apartarse.
- El motivo de cada fallo no viaja en los headers en ningún servicio: los consumidores deciden "reintentar o no" y el error solo queda en el log. En Go la decisión es un booleano que ya existía, y cambiarlo habría obligado a reescribir cerca de 70 tests.

### Excepción: réplica de autorización de Voice

El consumer `voice.signaling.<instance>.replica` no consume intentos cuando la
base de la réplica está caída: mantiene el mensaje sin confirmar, espera y lo
reencola hasta que PostgreSQL vuelva. Un payload inválido sí se publica en la
DLQ, porque descartarlo silenciosamente dejaría incompleta la autorización.
Esta excepción no cambia la política de los demás consumers. La cola efímera
que usa `PresenceConsumer` para `voice.participant_*` y `voice.private_call`
no tiene DLQ: sus eventos se confirman siempre y el estado activo se recupera
con `VoicePresenceReconciler` al reconectar.
