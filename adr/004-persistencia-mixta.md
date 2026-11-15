# ADR-004: Persistencia Mixta (PostgreSQL y MongoDB)

**Estado:** Aceptado

## Contexto

Los dominios del sistema presentan patrones de acceso a datos heterogéneos. Las entidades de usuarios, roles, servidores y monetización exigen relaciones estructuradas e integridad transaccional ACID. En contraposición, la mensajería genera un gran volumen de escrituras continuas con esquemas de datos altamente flexibles (adjuntos, menciones, reacciones).

## Decisión

Implementar una estrategia de persistencia basada en PostgreSQL para los microservicios relacionales/transaccionales y MongoDB para la persistencia del historial de mensajes en el servicio de Mensajería.

## Consecuencias

- **Positivas:**
    - Garantías de consistencia ACID e integridad referencial en el núcleo transaccional mediante PostgreSQL.
    - Alta velocidad de escritura y flexibilidad en la evolución de atributos de mensajes mediante MongoDB.
    - Conocimiento sobre el manejo de ambos motores de base de datos
    - Optimización de rendimiento al no forzar un modelo relacional sobre el historial masivo de chat.
- **Negativas:**
    - Incremento en la carga operativa al administrar dos tecnologías de bases de datos distintas.
    - Imposibilidad de ejecutar transacciones ACID atómicas entre el historial de chat y las entidades relacionales.
    - [ScyllaDB](https://www.scylladb.com/) es superior para mensajería masiva a gran escala debido a su altísimo rendimiento de escritura
