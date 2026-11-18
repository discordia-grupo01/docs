# ADR-004: Persistencia mixta, PostgreSQL y MongoDB

**Estado:** Aceptado
**Servicios:** todos los de dominio (PostgreSQL), `messaging` y `notifications` (MongoDB)
**Relacionadas:** ADR-017 (réplica local), ADR-018 (outbox)

## Contexto

La consigna pide usar al menos una base de datos relacional y una no relacional, y los dominios del sistema justifican las dos. Los usuarios, los roles, los servidores y la monetización necesitan relaciones estructuradas e integridad transaccional. La mensajería, en cambio, genera muchas escrituras continuas con datos de forma flexible, como adjuntos, menciones y reacciones, y el servicio de notificaciones guarda estado derivado de eventos, como los marcadores de lectura y las réplicas de permisos.

## Decisión

Usamos PostgreSQL para los servicios relacionales y transaccionales, y MongoDB para el historial de mensajes de `messaging` y para el estado de `notifications`. Cuando un servicio con Mongo necesita una transacción, como en el outbox de `messaging`, usa un PostgreSQL aparte para eso (ADR-018).

Cada servicio es dueño de sus datos y ningún otro los toca. Los planes gratuitos nos dan pocos proyectos: Supabase permite dos y MongoDB Atlas uno, así que no podíamos tener un proyecto por servicio. En producción los Postgres viven en un único proyecto de Supabase, con un schema por servicio (`identify`, `servers`, `admin`, `messaging` y uno para cada uno de los demás), y cada servicio fija su `search_path` a su schema y no consulta el de otro. Los dos servicios con Mongo usan, dentro del único proyecto de Atlas, bases separadas. Cuando un servicio necesita un dato de otro, no lo consulta: lo recibe por eventos y guarda su propia copia (ADR-017).

## Alternativas descartadas

- **Neo4j u otra base de grafos.** La consideramos porque una red social tiene relaciones entre usuarios, pero al revisar los casos de uso vimos que no hay consultas de grafos, como recomendaciones o caminos entre usuarios, que justificaran sumar una tecnología más.
- **Cassandra.** Tampoco apareció un caso de uso que la justificara frente a MongoDB, que ya cubría la mensajería con una forma de datos flexible y que el equipo conocía.

## Consecuencias

El núcleo transaccional queda con integridad referencial y garantías ACID gracias a PostgreSQL, y el historial de mensajes escribe rápido y evoluciona sin migraciones gracias a MongoDB. Además el equipo ya conocía los dos motores y no forzamos un modelo relacional sobre un historial masivo de chat.

A cambio, hay más carga operativa por manejar dos tecnologías de bases de datos, y no se pueden hacer transacciones atómicas entre el historial de chat y las entidades relacionales. Esa limitación es la que nos llevó a usar un outbox para publicar eventos de forma confiable (ADR-018). Y compartir un único proyecto de Supabase significa que todos los servicios comparten sus límites de espacio y de conexiones.
