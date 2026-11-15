# ADR-013: Comunicación Síncrona para la Unión al Chat de Voz

**Estado:** Reemplazado (ADR-028)

## Contexto

Cuando un usuario intenta unirse a un canal de voz, el servicio de signaling en Elixir debe obtener un token de acceso para LiveKit, y para ello es necesario validar previamente que el usuario tiene permiso para ingresar al canal. Esa información (pertenencia al servidor, existencia del canal, roles y permisos) es responsabilidad del servicio de Servidores/Canales. El resto de la arquitectura utiliza mensajería asíncrona mediante RabbitMQ, pero este flujo requiere una respuesta inmediata para poder continuar o rechazar la unión.

## Decisión

Utilizar comunicación síncrona vía HTTP entre el servicio de signaling (Elixir) y el servicio de Servidores/Canales. El signaling envía una petición HTTP para solicitar el token; el servicio de Servidores/Canales valida los permisos del usuario y responde con el token o con un rechazo. No se utiliza RabbitMQ para este caso.

## Consecuencias

- **Positivas:**
    - Respuesta inmediata, necesaria para permitir o denegar la unión en tiempo real.
    - Flujo simple y fácil de razonar, con validación centralizada de permisos en el servicio dueño de esa información.
- **Negativas:**
    - Acoplamiento temporal: si el servicio de Servidores/Canales no está disponible, los usuarios no pueden unirse a canales de voz.
    - La latencia de la llamada HTTP se suma al tiempo de ingreso al canal.
    - Requiere manejar timeouts y errores de red de forma explícita.
