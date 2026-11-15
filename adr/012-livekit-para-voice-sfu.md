# ADR-012: Uso de LiveKit para Voice-SFU

**Estado:** Aceptado

## Contexto

Se requiere un componente SFU (Selective Forwarding Unit) para el servicio de chat de voz, encargado de recibir y redistribuir los flujos de audio entre los participantes de un canal. Inicialmente se planteó un repositorio mixto, con un SFU desarrollado en Go y un servicio de signaling en Elixir. Sin embargo, construir y mantener un SFU propio implica una complejidad considerable (manejo de WebRTC, negociación de medios, control de congestión, escalabilidad), que excede el alcance y los recursos del equipo. LiveKit es una solución de código abierto que ya resuelve estas problemáticas y se integra de forma sencilla con el resto de la arquitectura.

## Decisión

Adoptar LiveKit como SFU para el chat de voz, delegándole el transporte y la distribución de medios, y desarrollar únicamente el servicio de signaling en Elixir. Se descarta el repositorio mixto Go + Elixir.

## Consecuencias

- **Positivas:**
    - Menor complejidad de desarrollo y mantenimiento al delegar el SFU a una solución probada y de código abierto.
    - Repositorio y stack de signaling unificados en Elixir, sin necesidad de mantener dos lenguajes para el servicio de voz.
    - Reducción del tiempo de implementación al evitar construir la infraestructura WebRTC desde cero.
- **Negativas:**
    - Dependencia de un componente externo, con menor control sobre su evolución y comportamiento interno.
    - Necesidad de desplegar, configurar y operar la infraestructura de LiveKit.
