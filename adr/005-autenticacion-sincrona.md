# ADR-005: Autenticación mediante request-response sincrónico

**Estado:** Aceptado

## Contexto

El enunciado establece que la comunicación entre servicios debe ser asíncrona por defecto, y que una llamada sincrónica debe justificarse explícitamente. El login es el caso de excepción: el cliente necesita el JWT para adjuntarlo a cada request subsiguiente. Sin ese token no puede ejecutar ninguna acción autenticada, abrir WebSockets ni recibir mensajes. El flujo es autocontenido en `discordia-identify` y no requiere información de ningún otro servicio.

## Decisión

El endpoint `POST /api/v1/auth/login` opera de forma sincrónica: el cliente envía credenciales, Kong enruta a `discordia-identify`, y el servicio devuelve el JWT y el refresh token en la misma conexión HTTP. Los efectos secundarios (registrar último acceso, emitir evento de auditoría) se publican en RabbitMQ de forma asíncrona después de responder al cliente. Kong valida el JWT en requests subsiguientes de forma local usando la clave pública RSA con que `discordia-identify` firma los tokens, sin llamar al servicio de identidad en cada request.

## Consecuencias

- **Positivas**:
    - El cliente obtiene el JWT en una sola request sin pasos adicionales.
    - El flujo no depende de otros servicios, lo que aísla fallos.
    - Los servicios downstream validan tokens localmente sin dependencia de red en el hot path.
- **Negativas**:
    - Si `discordia-identify` no está disponible, ningún usuario nuevo puede autenticarse. Mitigado con múltiples instancias y health checks.
    - El hashing BCrypt limita el throughput de autenticaciones concurrentes; mitigado con rate limiting en Kong por IP y por cuenta.
