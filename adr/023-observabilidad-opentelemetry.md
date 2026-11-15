# ADR-023: observabilidad: trazas, métricas y logs con OpenTelemetry enviados a New Relic, con el id de traza propagado por RabbitMQ

**Estado:** Aceptada  
**Fecha**: 2026-11-07 (actualizada el 2026-11-08)  
**Servicios**: los ocho (`servers`, `identify-service`, `admin`, `billing`, `metrics`, `messaging`, `notifications` y `voice-sfu`); migraciones nuevas en `servers` (`0033`), `identify-service` (`000021`), `admin` (`000009`), `billing` (`0006`) y `messaging` (`0003`)  
**Decidida por**: Facundo Madotta (diseño, implementación y pruebas)

**Consigna**: Observabilidad: un sistema APM o equivalente por servicio, con trazabilidad distribuida y un id de correlación propagado entre servicios, incluidas las conexiones de mensajería en tiempo real (esto último se valora)

**Relacionadas**: ADR 07 (Mensajería Pub/Sub), ADR-018 (outbox transaccional de messaging)

## 1. Contexto

La consigna pide que cada servicio tenga un sistema de observabilidad (APM o equivalente) para supervisar su estado operativo y diagnosticar fallas, y valora una traza distribuida con un id de correlación propagado entre servicios, incluidas las conexiones de mensajería en tiempo real. Antes de esta decisión el sistema tenía logs JSON con nivel configurable y los endpoints `/livez` y `/readyz`, pero ni trazas ni métricas de rendimiento. Lo que condiciona la elección:

- **Ocho servicios en dos lenguajes.** `servers`, `identify-service`, `admin`, `billing` y `metrics` están en Go; `messaging`, `notifications` y `voice-sfu`, en Elixir. Se despliegan en VMs, en Render y en Fly.io.
- **Una acción cruza varios servicios por RabbitMQ.** Borrar un servidor se escribe en la base de `servers`, pasa por el outbox, sale por RabbitMQ y lo consumen `identify-service`, `messaging`, `notifications` y `voice-sfu`. Sin un id compartido no hay forma de seguir esa acción de punta a punta.
- **El outbox separa el pedido de la publicación.** El poller publica unos segundos después y en otro proceso (ver ADR-018), así que el contexto del pedido original no llega solo al mensaje.
- **Datos personales.** La consigna prohíbe que el email, los mensajes privados y el historial de pagos aparezcan en logs o en respuestas de error. Una traza es otro lugar por donde un dato puede escaparse, y además se envía a un tercero.
- **Presupuesto.** El proyecto corre en planes gratuitos.

## 2. Decisión

### 2.1 OpenTelemetry para instrumentar

Todos los servicios se instrumentan con **OpenTelemetry**, el estándar abierto para trazas, y envían los datos por OTLP sobre HTTP. El código no depende de ningún proveedor: cambiar de destino es cambiar dos variables de entorno. Go y Elixir usan el mismo modelo, y el id viaja en el encabezado estándar `traceparent` (W3C Trace Context), que entienden ambos lenguajes.

Se instrumentan las trazas (secciones 2.4 a 2.6), la métrica HTTP de duración de los pedidos (2.8) y el envío de logs (2.9). Las métricas del proceso quedan fuera (sección 4).

### 2.2 New Relic como destino

Los datos van a **New Relic** (cuenta de EE. UU.), por `https://otlp.nr-data.net`. Se autentican con el encabezado `api-key`, cuyo valor es una clave de licencia de ingesta. Las razones:

- **Es un APM propiamente dicho.** Cumple la consigna sin tener que justificar un equivalente.
- **El plan gratuito no vence.** Da 100 GB de ingesta al mes y un usuario completo (el resumen del plan de la cuenta lo muestra así el 2026-11-07), y no pide tarjeta.
- **Recibe OTLP directamente.** Los servicios le envían sin un colector intermedio, lo que también sirve a los que corren en Render y en Fly.io.

Está **apagado por defecto**: sin `OTEL_EXPORTER_OTLP_ENDPOINT` no se crea ningún exportador y el servicio funciona igual, en local, en los tests y en cualquier despliegue que no lo configure.

### 2.3 Variables de entorno y secreto

- **`OTEL_EXPORTER_OTLP_ENDPOINT`:** `https://otlp.nr-data.net`. No es un secreto.
- **`OTEL_EXPORTER_OTLP_HEADERS`:** `api-key=<clave de licencia de ingesta>`. Es un secreto: se carga solo como variable de entorno del despliegue, nunca en el repositorio ni en un chat.
- **`OTEL_SERVICE_NAME`:** opcional; por defecto cada servicio usa su nombre. En staging conviene un nombre distinto (por ejemplo `voice-sfu-staging`), porque la cuenta es una sola.
- **`OTEL_TRACES_SAMPLER`:** opcional, muestreo estándar de OpenTelemetry, para no pasar el límite de ingesta.
- **`LOG_SHIP_URL`:** opcional, `https://log-api.newrelic.com/log/v1`. Activa el envío de logs (sección 2.9). No es un secreto.
- **`LOG_SHIP_API_KEY`:** opcional, la clave para el envío de logs. Si falta, se usa la `api-key` de `OTEL_EXPORTER_OTLP_HEADERS`, así que no hay otro secreto.

Una sola clave sirve para todos los servicios.

### 2.4 Qué se mide

- **Pedidos HTTP.** Un span por pedido, llamado como el patrón de la ruta (`POST /v1/servers`, no la ruta real). Si el pedido trae un `traceparent`, la traza continúa desde ahí.
- **Base de datos.** Un span por consulta, con la operación y el SQL con sus `$1`, `$2`, sin los valores. En `servers`, `billing` y `metrics` con un trazador de `pgx`; en `identify-service` y `admin`, que usan `lib/pq`, con `otelsql`. Las consultas que no pertenecen a un pedido ni a un evento, como el barrido del outbox cada 2 segundos, no generan spans: serían miles de trazas sin información.
- **Eventos consumidos.** Cada mensaje abre un span `<routing key> process` dentro de la traza que trae en `traceparent`. Si el evento va a reintento, el span queda marcado como error. Si no la trae (eventos anteriores o de otro publicador), empieza una traza nueva.
- **Logs.** Cada línea escrita dentro de un pedido o de un evento lleva `trace_id` y `span_id`, así que se pasa del log a la traza.

### 2.5 El id cruza el outbox: columna traceparent

Cuando un servicio escribe un evento en `outbox_events`, guarda también el `traceparent` del pedido en una columna nueva, `traceparent`, que acepta nulos. El poller lee esa columna, abre un span `outbox publish <routing key>` dentro de esa traza y publica el mensaje con el encabezado `traceparent`. Así el consumidor queda en la misma traza que el pedido que originó el evento, aunque pase tiempo en el medio.

Es una migración aditiva por servicio con outbox: `servers` `0033`, `identify-service` `000021`, `admin` `000009`, `billing` `0006` y `messaging` `0003`. Los eventos que ya estaban en el outbox quedan con `traceparent` nulo y se publican igual. `metrics` publica directo, sin outbox: el mensaje sale con el `traceparent` de la traza en curso. En `messaging` el `traceparent` sale del span que está abierto al anotar el evento, sea el de un pedido HTTP o el de un mensaje de WebSocket (sección 2.10).

### 2.6 Qué nunca se exporta

Las librerías de instrumentación del ecosistema registran por defecto más datos de los que se quiere exportar (el path real, la query string, datos del cliente). Eso contradice la minimización de datos de la consigna, así que el middleware HTTP, el trazador de la base y la propagación están escritos en el proyecto: son unos pocos archivos por servicio. Las reglas:

- **Del pedido** solo se guardan el método, el patrón de la ruta y el código de respuesta. Nunca el path real (lleva ids), la query string (puede llevar tickets), los encabezados ni la IP.
- **De las consultas** se guarda el SQL con sus marcadores, sin valores. Con `pgx` se corta a 500 caracteres.
- **De un error de consulta** solo se guarda el código de Postgres (por ejemplo `23505`), no su texto, que puede traer valores de la fila.
- **El exportador** borra `exception.message` y `exception.stacktrace` de todos los spans antes de enviarlos, así que un error registrado en cualquier punto del código no filtra su texto.

### 2.7 Código compartido

El paquete `internal/telemetry` es el mismo en los cinco servicios de Go: una copia por repositorio, igual que `internal/logging` y `deadletter`, porque cada repositorio es un módulo aparte. En Elixir, `Tracing` es el mismo módulo en `messaging`, `notifications` y `voice-sfu`, y solo cambia el nombre del servicio.

### 2.8 Métricas HTTP

Los spans no alcanzan para llenar la vista de rendimiento de New Relic: esa vista se arma con la métrica `http.server.request.duration`, y sin ella el resumen muestra "Required metrics are missing". Cada servicio registra esa métrica al terminar cada pedido, como un histograma en segundos con temporalidad delta, exportado cada 60 segundos por el mismo OTLP. Lleva `http.request.method`, `http.route` (el patrón, o `unmatched`) y `http.response.status_code`, y `error.type` solo cuando la respuesta es 5xx, que es lo que New Relic cuenta como error. Los buckets van de 5 ms a 10 s. En Go se registra en el mismo middleware que arma el span; en Elixir, con el SDK experimental de métricas, desde el mismo manejador de telemetría de Phoenix.

### 2.9 Envío de logs a New Relic

Los logs siguen saliendo por la salida estándar y, además, cada servicio puede enviarlos al Log API de New Relic. Está apagado por defecto: se activa con `LOG_SHIP_URL` y una clave, que sale de `LOG_SHIP_API_KEY` o, si no está, de la `api-key` de `OTEL_EXPORTER_OTLP_HEADERS`.

- **Mismo contenido, mismo filtrado.** Se envía lo mismo que sale por la salida estándar, con el mismo saneado: campos como `password`, `token`, `ticket`, `email` o `content`, y emails o JWT dentro de un texto. En Go, un segundo manejador de `slog` alimenta la cola; en Elixir, un manejador de `:logger` reutiliza el formateador.
- **Enlace con la traza.** `trace_id` y `span_id` viajan como `trace.id` y `span.id`, que es como New Relic une cada log con su traza, y el servicio se identifica con `service.name` y `entity.name`.
- **Lotes, reintentos y cola acotada.** Lotes de hasta 200 entradas o cada 5 segundos, comprimidos en gzip y por HTTPS, sin que el pedido espere. Ante errores de red, 408, 429 y 5xx reintenta con una espera de 1 a 60 segundos; un lote rechazado de forma definitiva (400 o 403) se descarta. La cola guarda hasta 5.000 entradas y descarta las más viejas, para no crecer sin límite en memoria.
- **Sin bucles.** Los avisos del propio envío salen por la salida estándar y nunca se reenvían.
- **Al apagar.** Intenta enviar lo pendiente durante unos 3 segundos.

### 2.10 Del WebSocket a RabbitMQ

Un mensaje de chat entra a `messaging` por un WebSocket, y el navegador no manda `traceparent`. Para que la traza llegue igual hasta `notifications` no hace falta cambiar los clientes:

- **El servidor abre la traza.** Cada mensaje que llega a un canal de sala (`new_message`, `edit_message`, `delete_message`, `add_reaction` y `remove_reaction`) abre un span `WS <evento>`. Solo guarda el nombre del evento: nunca el contenido ni ids de canal o de usuario.
- **El outbox guarda la traza.** Al anotar el evento, `messaging` escribe el `traceparent` del span abierto en la columna nueva `outbox_events.traceparent`.
- **El poller la retoma.** Abre un span `outbox publish <evento>` dentro de esa traza y publica el mensaje con el encabezado `traceparent`, tanto en `discordia.events` como en el fanout entre instancias. `notifications` continúa la misma traza al procesar `messaging.message_created`. Una fila sin `traceparent` se publica igual.
- **Errores.** El span queda marcado como error ante una falla del servidor (5xx) o una excepción; un error del cliente, como un payload inválido o la falta de permiso, no.

## 3. Alternativas descartadas

- **Grafana Cloud (Tempo y Loki):** Ya había una cuenta creada, con un plan gratuito de 50 GB de trazas y 50 GB de logs al mes y 14 días de retención. Se descartó porque la cuenta era una prueba gratuita que vencía el 2026-11-21 y porque habría que justificar que OpenTelemetry con Grafana cuenta como "APM o equivalente". Pasar a Grafana más adelante es cambiar el endpoint y el encabezado.
- **Los agentes propios de New Relic:** Atan los ocho servicios a un solo proveedor, y cambiar de proveedor sería reescribir la instrumentación. Entre un agente de Go y uno de Elixir, además, la propagación del id hay que configurarla.
- **CloudWatch y X-Ray (AWS):** La infraestructura no está en AWS: habría que mandar los datos a otra nube, con otra cuenta y otras credenciales. Application Signals es gratis solo tres meses.
- **Papertrail:** Es solo para logs, no un APM, y no se pudo confirmar que su plan gratuito exista hoy.
- **Grafana y Tempo autoalojados en una VM:** Sin límite de ingesta y con los datos dentro de la infraestructura, pero es un servicio más que desplegar, vigilar y respaldar. Queda como plan B si se agota el plan gratuito.
- **Un colector de OpenTelemetry por máquina:** Agrega una pieza por VM, y Render y Fly.io no pueden alojarla. Los servicios envían directo.
- **Las librerías de instrumentación del ecosistema (`otelgin`, `opentelemetry_phoenix`):** Ver 2.6. Habría que verificar en cada versión que no registren datos de más; se prefirió código propio, corto y cubierto por tests.
- **Cambiar `lib/pq` por el driver de `pgx` en `identify-service` y `admin`:** Cambiar el driver de producción solo para poder medir es un riesgo mayor que envolverlo. `otelsql` lo envuelve sin cambiarlo.
- **Enviar los logs con el manejador de OTLP del SDK de Elixir:** Está marcado como experimental, no reutiliza el filtrado de datos sensibles de nuestros logs y su código deja pendiente el vaciado al apagar. Se escribió un envío propio que usa el mismo formateador y el mismo filtrado que la salida estándar.
- **Un recolector de logs que lea la salida estándar (por ejemplo Fluent Bit):** Es una pieza más por máquina y no puede correr en Render ni en Fly.io, donde están `notifications` y `voice-sfu`. Por eso cada servicio envía sus propios logs por HTTPS.

## 4. Consecuencias y límites

- **Los datos de trazas, métricas y logs salen a un tercero.** Van a New Relic, en EE. UU. Por diseño son operaciones, patrones de ruta, códigos de estado, SQL sin valores e ids de traza. Con un colector local se verificó que ni el id de un usuario ni el nombre de un servidor aparecen en lo exportado. Los logs llevan lo mismo que la salida estándar, ya filtrado (sección 2.9), y pueden incluir ids de usuario, de servidor y de canal, que ya estaban ahí; los mensajes y su contenido no.
- **Límite de 100 GB al mes.** Según la información de New Relic, al pasarse deja de recibir datos hasta el mes siguiente (no se probó); mientras no se cargue una tarjeta no hay cobro. Si el volumen se acerca, se baja con `OTEL_TRACES_SAMPLER`. Los logs y las métricas cuentan para el mismo límite, y `OTEL_TRACES_SAMPLER` baja solo las trazas, no los logs.
- **Una columna nueva por outbox.** Es una migración aditiva que se aplica al pasar a `main`. `messaging` suma la suya (`0003`), que se aplica antes del deploy porque el CI corre las migraciones antes de desplegar.
- **Una copia del paquete por repositorio.** Un cambio hay que replicarlo en los cinco servicios de Go (`internal/telemetry` e `internal/logging`) y en los tres de Elixir.
- **Versión de Go.** `identify-service`, `admin` y `metrics` pasan a `go 1.22.7` por las dependencias de OpenTelemetry.
- **Pendiente: Kong como inicio de la traza.** Hoy la traza empieza en el primer servicio que recibe el pedido. El plugin de OpenTelemetry viene incluido en `kong:3.6` gratuito y, con `header_type: ignore`, Kong abre siempre una traza propia y la inyecta en formato W3C hacia los servicios, sin confiar en el `traceparent` que mande un cliente. Hay que activar `KONG_TRACING_INSTRUMENTATIONS=request` y un muestreo del 100 % en el plugin, porque el muestreo global por defecto es del 1 % y los servicios descartarían casi todo. Por defecto el span de Kong exporta la URL completa con la query (donde viaja el ticket del WebSocket) y la IP del cliente, lo que contradice la sección 2.6; se pueden borrar con el plugin `pre-function`, pero esa parte no se terminó de verificar. Queda en pausa hasta consultarlo con el profesor.
- **WebSockets.** Resuelto sin tocar `web-client` ni `app-mobile`: `messaging` abre el span cuando llega el mensaje (sección 2.10), así que la traza de un mensaje de chat empieza en el servidor y llega hasta `notifications`. Que arranque en el cliente, mandando el `traceparent` al unirse a un canal o con cada mensaje, queda para consultarlo con el corrector.
- **Eventos que publican `messaging` y `voice-sfu`.** Resuelto en `messaging` (sección 2.10). En `voice-sfu` no hace falta: sus WebSockets reenvían la señalización WebRTC directo al SFU, sin pasar por RabbitMQ, y no se encontró ningún servicio que consuma los eventos de presencia de voz que publica (revisado el 2026-11-08).
- **Fuera de las trazas:** las consultas a Mongo, las llamadas salientes (Expo, Web Push, LiveKit y MercadoPago), las métricas del proceso y las alertas. Las alertas, como la de la DLQ con mensajes, siguen pendientes.
- **El navegador y la app no participan.** La traza empieza en el servidor.
