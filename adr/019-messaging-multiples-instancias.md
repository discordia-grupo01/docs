# ADR-019: messaging con más de una instancia: estado compartido, reparto en Kong y una sola instancia en producción

**Estado:** Aceptada  
**Fecha**: 2026-10-23  
**Servicios**: `messaging`, `gateway` (Kong), `infrastructure` (stack local)  
**Decidida por**: Facundo Madotta (diseño, implementación y pruebas)  
**Pedida por**: Indicación de la cátedra: "verificar que funciona con más de una instancia, pero mantener solo una"  
**Relacionadas**: ADR-016 (propagación en tiempo real), ADR-017 (réplica local), ADR-018 (outbox)

## 1. Contexto

`messaging` corre hoy como **una** instancia (un contenedor en la VM de Oracle). La cátedra pidió dos cosas a la vez:

1. **Demostrar** que el servicio funciona con más de una instancia.
1. **No escalar** el despliegue: en producción se mantiene una sola.

Para que lo primero sea cierto, ninguna instancia puede guardar en su memoria algo que las demás necesiten. Hay además una consecuencia propia del tiempo real: un usuario conectado por WebSocket **vive en una instancia concreta**, y los demás usuarios del canal pueden estar en otra.

Este ADR resume cómo se comporta el sistema con dos instancias, qué decisiones lo hacen posible, qué límites tiene y cómo se prueba. La propagación entre instancias en sí (el fanout de RabbitMQ) está en el ADR-016.

## 2. Decisión

### 2.1 Nada que importe vive en la memoria de la instancia

- **Mensajes, DM, bloqueos, menciones, adjuntos (metadatos)**: Dónde vive: Mongo; Cómo lo comparten las instancias: Todas leen y escriben lo mismo
- **Réplica de permisos, roles y usuarios (ADR-017)**: Dónde vive: Mongo; Cómo lo comparten las instancias: La alimentan los eventos; todas leen la misma
- **Tickets del WebSocket**: Dónde vive: Mongo; Cómo lo comparten las instancias: Un ticket pedido a una instancia se canjea en cualquiera, una sola vez (30 s)
- **Eventos pendientes de publicar (ADR-018)**: Dónde vive: Postgres (outbox); Cómo lo comparten las instancias: Cada poller toma filas con `FOR UPDATE SKIP LOCKED`: dos no toman la misma
- **Avisos en vivo (`new_message`, `new_dm`, `access_revoked`...)**: Dónde vive: Fanout `messaging.broadcast` (ADR-016); Cómo lo comparten las instancias: Una cola por instancia: todas reciben todo y entregan a sus conexiones
- **Eventos de `servers` e `identity`**: Dónde vive: Cola compartida `messaging.channel_lifecycle`; Cómo lo comparten las instancias: Las instancias compiten y cada evento lo procesa **una**

Lo único que cada instancia tiene "para sí" es la lista de sus propias conexiones WebSocket, que por definición no se comparte.

### 2.2 El reparto lo hace Kong, por petición

Las dos instancias se anuncian bajo **un mismo nombre**. En el stack local ese nombre es `messaging-pool`, un alias de red que ambos contenedores tienen. Kong resuelve el nombre por DNS, recibe las dos direcciones y **alterna entre ellas, petición por petición** (reparto rotativo, el comportamiento por defecto cuando un nombre resuelve a varias direcciones). Kong no tiene una lista de instancias escrita: las instancias existen para Kong por tener ese nombre.

- **No hay afinidad de sesión.** Ninguna petición "pertenece" a una instancia: REST y tickets van a cualquiera.
- **Una conexión WebSocket, una vez abierta, se queda en la instancia que la aceptó** hasta que se cierra.
- Un cliente no elige instancia y no la conoce: el balanceo es transparente. (El cliente de la demo hace tres peticiones al servicio para armar una conexión: ticket, socket e historial.)
- `messaging-service` tiene **`connect_timeout: 3000`**. Con el valor por defecto de Kong (60 s), cuando una instancia moría Kong seguía mandándole una parte del tráfico y cada intento esperaba un minuto antes de probar con la otra.

### 2.3 Si una instancia cae, el cliente se reconecta y se pone al día

Los clientes de la instancia caída pierden la conexión. El cliente (el web-client, y el cliente de terminal de la demo):

1. Detecta el cierre y pide un **ticket nuevo** por Kong (el viejo se gastó).
1. Abre el WebSocket otra vez por la **misma URL**: Kong lo manda a la instancia que sigue viva (hasta 3 s de espera por la muerta).
1. Se une al canal con `last_message_id` y recibe en `missed_messages` lo que se envió mientras estuvo desconectado.

El servidor no mueve conexiones ni mantiene sesiones: la reconexión es del cliente, apoyada en tickets que sirven en cualquier instancia y en un historial compartido.

### 2.4 El orden se garantiza por mensaje, y se ordena por id

Un mensaje y sus ediciones y borrado salen en orden (el outbox no publica dos eventos del mismo mensaje a la vez). Entre mensajes distintos, con más de un poller, el orden de llegada **puede variar** si se envían a ráfagas. Los ids son UUIDv7 (ordenables por tiempo y monótonos dentro de una instancia): **el cliente ordena por `id`**, no por orden de llegada.

### 2.5 En producción, una sola instancia

`MESSAGING_UPSTREAM_URL` en el gateway de producción es una sola dirección fija (la IP de Tailscale de la VM de `messaging`). La segunda instancia y el alias `messaging-pool` existen **solo** en el archivo `infrastructure/docker-compose.multi.yml`, que se usa para probar y para la demo. Si algún día se escalara, bastaría con apuntar `MESSAGING_UPSTREAM_URL` a un nombre que resuelva a todas las instancias, o definir en Kong un `upstream` con un `target` por instancia.

## 3. Alternativas descartadas

- **Afinidad de sesión en Kong (por ejemplo, hash por usuario o canal)**: Mantendría a cada usuario en "su" instancia, pero no hace falta: el estado es compartido y la reconexión recupera lo perdido. Agrega configuración (un `upstream` explícito) y no resuelve la caída de una instancia.
- **Una instancia por canal o por servidor (partir el tráfico)**: Resuelve el orden, pero obliga a un directorio de "qué instancia atiende qué" y un punto de coordinación. Es mucho más complejo que lo que se necesita para una sola instancia en producción.
- **Guardar sesiones o conexiones en memoria compartida (por ejemplo Redis)**: Rompe la regla del proyecto de no guardar estado en memoria que importe entre instancias, y suma una pieza nueva.
- **Escalar en producción**: La cátedra pidió explícitamente no hacerlo.
- **Orquestador (Kubernetes, Swarm)**: Desproporcionado para una demostración con dos contenedores.

## 4. Consecuencias

### Positivas

- Sumar instancias no requiere cambios en `messaging`: se levanta otra con el mismo nombre de red.
- Una instancia que cae no pierde mensajes: están en el outbox y en Mongo, y los clientes se ponen al día.
- Probado con el web-client real y con un cliente de terminal.

### Negativas y riesgos conocidos

1. **Una instancia que se reinicia crea una cola nueva** (`messaging.broadcast.<id>`, con un id nuevo por proceso). Lo que se publicó mientras estuvo caída quedó en la cola vieja, que no se le entrega, y la cola vieja vence a los 10 minutos sin consumidor. Los clientes lo recuperan por el historial. (Distinto del caso de un corte de RabbitMQ con el proceso vivo: ahí la cola conserva su nombre y espera.)
1. **Orden entre mensajes distintos con ráfagas** y más de una instancia: medidas unas 3 a 5 inversiones cada 20 mensajes enviados a la vez; con una sola instancia, o con mensajes de a uno, ninguna.
1. **Kong guarda las direcciones que resolvió.** Al caer una instancia puede seguir mandándole una parte del tráfico hasta que expire su caché de DNS. El `connect_timeout` de 3 s acota el costo: la reconexión tarda unos 3 s. Tras cambiar la configuración de Kong hay que reiniciarlo.
1. **La conexión se cierra a los 60 s sin actividad del cliente.** Un cliente tiene que mandar latidos (`heartbeat`); el cliente de Phoenix los manda solo, pero un cliente hecho a mano (Postman, scripts) no.
1. **El reparto depende del patrón de peticiones.** Con dos instancias y un cliente que hace un número par de peticiones por conexión, todos los clientes pueden caer en la misma. Con las tres peticiones por conexión del cliente de la demo (ticket, socket e historial), clientes consecutivos se alternan; no medí el patrón exacto del web-client.
1. **Arranque en frío.** Un usuario recién registrado no existe para `messaging` hasta que llega su evento de perfil (unos segundos), como en el ADR-017.

### Qué se descubrió probándolo (y quedó corregido)

- Con `connect_timeout` por defecto (60 s), reconectar tras la caída de una instancia fallaba porque el ticket (30 s) vencía durante la espera. Se fijó en 3 s.
- Un cliente sin latidos perdía la conexión a los 60 s sin hablar, y parecía una caída de instancia. Los clientes de prueba mandan latidos cada 25 s.
- Ticket y socket son dos peticiones seguidas: con dos instancias, el socket de varios clientes consecutivos caía siempre en la misma. No es un error del sistema (ver el riesgo 5).

## 5. Lo que no cubre

- Escalar en producción (decisión de la cátedra: una instancia).
- Mover conexiones ya abiertas de una instancia a otra: la reconexión es del cliente.
- Más de dos instancias (la prueba usa dos; el diseño no depende del número).
- Afinar el algoritmo de reparto de Kong (se usa el rotativo por defecto).

## 6. Seguimiento

- Si se escalara: apuntar `MESSAGING_UPSTREAM_URL` a un nombre que resuelva a todas las instancias (o definir un `upstream` de Kong) y revisar la conexión de RabbitMQ y el uso de Mongo con más conexiones.
- Confirmar que el web-client y el app-mobile ordenan por `id` y deduplican por `id`.

Resultado de la prueba automática: **53 comprobaciones, varias corridas seguidas sin fallas**, también con el código actual de `develop` de los demás servicios. Se corre con `docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.multi.yml up -d --build` y `node scripts/multi-instance-check.mjs` desde `infrastructure/`.

Código y configuración: `infrastructure/docker-compose.multi.yml`, `infrastructure/scripts/multi-instance-check.mjs`, `infrastructure/scripts/demo-multi-instance.mjs`, `gateway/kong/kong.yml.template` (`connect_timeout`), `messaging/lib/messaging/events/broadcast_consumer.ex`, `messaging/lib/messaging/outbox/`.
