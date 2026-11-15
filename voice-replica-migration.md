# Réplica de autorización para Voice

## Etapa 1: signaling

`voice-sfu/signaling` ya contiene una proyección local en PostgreSQL y un
consumer RabbitMQ separado (`voice.signaling.<instance>.replica`). Consume las
fotos actuales de:

- roles y roles de miembros;
- overrides de canales;
- dueño del servidor;
- canales creados/eliminados y servidores eliminados;
- miembros que se fueron;
- mutes y unmutes;
- perfiles públicos.

Cada actualización usa `occurred_at` contra `voice_replica_clocks`. La marca
queda aunque se borre la fila, por lo que un evento atrasado no resucita una
entidad. Los errores de base se reencolan sin consumir el presupuesto de la
DLQ; los payloads inválidos sí se apartan.

Los eventos que produce o consume signaling no se conservan en buffers,
Agents ni mapas en memoria. Los eventos salientes se insertan en
`voice_outbox_events` y el publisher los publica y marca como enviados después
de la confirmación de RabbitMQ. Los eventos entrantes se registran en
`voice_consumed_events` antes de aplicar sus efectos; los estados `pending` y
`failed` se pueden reintentar y los `processed` se ignoran en redeliveries.
`VOICE_EVENTS_DATABASE_URL` permite separar esta base de auditoría de la
proyección si la operación lo requiere.

`VOICE_AUTHZ_MODE=replica` autoriza directamente con la proyección.
`VOICE_AUTHZ_MODE=replica_shadow` compara contra `servers` y todavía devuelve
la decisión de `servers`, para validar paridad antes del corte.

Esta etapa no hace backfill por sí sola. Una base vacía no debe usarse como
autorización de producción hasta completar la etapa 2.

## Etapa 2: productores y operación

La publicación incremental ya está implementada en `servers` mediante el
outbox transaccional. Para una réplica nueva, `servers` también incorpora el
comando `make backfill-voice`, que publica el snapshot vigente de autorización
directamente en la cola `VOICE_EVENTS_QUEUE.VOICE_INSTANCE_ID.replica`.

El backfill:

- publica roles, miembros y sus roles, dueño, canales de voz, overrides y
  mutes vigentes;
- usa el último timestamp persistido disponible de cada entidad (`created_at`,
  `updated_at`, `assigned_at`, `resolved_at`, `muted_at` o `joined_at`);
- usa el exchange default con la routing key igual a la cola, verifica que la
  cola exista y espera confirmación del broker;
- soporta `--dry-run` para contar sin publicar.

Los cambios incrementales y la revocación de acceso ya quedan cubiertos por el
outbox de `servers`: los eventos conservan sus routing keys y se insertan en la
misma transacción que el cambio de dominio; `channel_access_revoked` se emite
para pérdida de permisos, ban, expulsión y abandono.

La reconciliación periódica y el replay ya están disponibles:

- `servers` acepta `make backfill-voice ARGS="--interval 5m"` para volver a
  publicar el snapshot vigente en la cola de una réplica.
- `admin` acepta `VOICE_DLQ_QUEUES=... make voice-dlq-check`; inspecciona cada
  `voice.*.dlq` configurada y termina con código 2 si alguna tiene mensajes.
- Para recuperar mensajes, usar primero `VOICE_DLQ_QUEUES=... make
  voice-dlq-replay ARGS="--limit 100"`. El replay publica al exchange y
  routing key originales y solo confirma el mensaje de la DLQ después de una
  confirmación positiva del broker.

La operación debe configurar una alarma separada para cada cola listada en
`VOICE_DLQ_QUEUES`, ejecutando `make voice-dlq-check` cada minuto. El umbral
recomendado es `0`; no se deben borrar mensajes de una DLQ para silenciar la
alarma. Investigar primero la causa, corregirla y replayar en lotes acotados.

Procedimiento de recuperación:

1. Identificar la réplica y la routing key original con `make
   voice-dlq-check`/RabbitMQ Management; no replayar una cola que no empiece
   con `voice.`.
2. Corregir la causa del fallo y ejecutar `make voice-dlq-replay
   ARGS="--limit 100"`.
3. Esperar confirmación del consumidor y repetir por lotes hasta que el check
   quede en cero.
4. Ejecutar `make backfill-voice ARGS="--dry-run"` y, si persisten diferencias,
   correr un backfill puntual para esa réplica.

El corte ya fue realizado con `VOICE_AUTHZ_MODE=replica`; `servers_api` queda
como rollback. La prioridad posterior al corte es mantener el reconciliador
periódico y alarmas activas para las DLQ de comandos, réplica y suspensiones de
cada instancia. La cola efímera de presencia no tiene DLQ y se recupera con
`VoicePresenceReconciler`.
