# ADR-003: Arquitectura de Voz en Tiempo Real (Go con Pion WebRTC y Elixir)

**Estado:** Reemplazado (ADR 013)

## Contexto

El módulo de Canal de Voz necesita separar dos responsabilidades principales: la señalización (negociación SDP/ICE) de las sesiones de llamada y el enrutamiento pesado de paquetes de audio en tiempo real mediante un servidor SFU (*Selective Forwarding Unit*).

## Decisión

Desacoplar la solución utilizando **Elixir (Phoenix)** para la capa de señalización y control de estado, y **Go utilizando la librería Pion WebRTC** para la implementación del motor SFU de retransmisión de medios, complementado con infraestructura STUN/TURN.

## Consecuencias

- **Positivas:**
    - Eficiencia máxima en el procesamiento y transmisión de paquetes UDP/RTP en Go sin sobrecargar la máquina virtual BEAM.
    - Desacoplamiento claro entre el plano de control (señalización) y el plano de medios (audio).
    - Uso de *Pion WebRTC*, una librería que permite una mayor abstracción.
- **Negativas:**
    - Mayor complejidad de coordinación por eventos entre el servicio de señalización en Elixir y el SFU en Go.
