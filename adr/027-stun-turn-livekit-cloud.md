# ADR-027: Uso de infraestructura STUN/TURN administrada por LiveKit Cloud

**Estado:** Aceptada  
**Fecha:** 12/11/2026  
**Servicios:** Voice signaling, Web Client, App mobile  
**Relacionadas:** ADR 012 (Uso de Livekit para Voice-SFU)

## Contexto

Para garantizar la conectividad WebRTC en producción del servicio de chat de voz (definido en ADR-012) desde redes con NAT restrictivos o firewalls corporativos, es necesario contar con mecanismos confiables de descubrimiento de rutas (ICE/STUN) y retransmisión de medios (TURN). Se evaluó el comportamiento de la infraestructura administrada por LiveKit Cloud mediante pruebas en distintas condiciones de red: en red abierta y datos móviles (hotspot), la comunicación operó mediante UDP directo (host con RTT de ~33 ms y prflx con RTT variable entre 37 y 178 ms, respectivamente); ante el bloqueo de UDP, el cliente negoció correctamente ICE/TCP por el puerto 7881 (~31 ms); y en escenarios restrictivos sin UDP ni puerto 7881 —incluyendo redes habilitadas únicamente por TCP 443— la conexión se estableció exitosamente mediante TURN/TLS (relayProtocol: tls) manteniendo una latencia equivalente a la ruta directa (~33–37 ms). Asimismo, al simular un corte abrupto de UDP en plena llamada, el cliente migró automáticamente a TURN/TLS (~33 ms) sin perder la sesión, registrando una ventana de reconexión de entre 20 y 25 segundos sin audio (disconnected en t=14 s hasta restablecerse en t=38 s). Desplegar y mantener una infraestructura propia basada en coturn (alta disponibilidad, certificados TLS, escalado y monitoreo) o integrar un proveedor externo implicaría una carga operativa que no se justifica frente a las capacidades validadas en LiveKit Cloud.

## Decisión

Delegar la infraestructura STUN/TURN en los servicios administrados por LiveKit Cloud para el establecimiento y retransmisión de conexiones WebRTC en producción, aprovechando su soporte nativo para UDP, ICE/TCP (7881) y TURN/TLS (443). Se descarta inicialmente el despliegue de servidores coturn propios y la contratación de un proveedor externo de STUN/TURN.

## Consecuencias

- **Positivas**:
    - Conectividad garantizada desde redes con firewalls restrictivos (incluso limitadas exclusivamente a TCP 443) mediante TURN/TLS, con latencias comparables al tráfico UDP directo (~33–37 ms).
    - Cero carga operativa de despliegue, escalado, mantenimiento y gestión de certificados TLS al evitar operar un clúster propio de coturn.
    - Integración nativa y transparente con la arquitectura basada en LiveKit (ADR-012), sin sumar dependencias ni contratos con proveedores externos.
    - Recuperación automática de llamadas activas ante pérdida de conectividad UDP sin caída de la sesión.
- **Negativas**:
    - Ante un corte repentino de UDP durante una llamada en curso, el proceso de fallback hacia TURN/TLS genera una interrupción temporal de ~20–25 segundos sin audio hasta que el cliente completa la reconexión.
    - Dependencia de la disponibilidad, límites de servicio y costos asociados al tráfico relay (TURN) de LiveKit Cloud.
    - Menor control sobre los parámetros internos de negociación ICE y timeouts de reconexión en comparación con una instalación autogestionada.

| **#** | **Escenario** | **Camino real** | **RTT** | **Resultado** |
|---|---|---|---|---|
| 1 | Red abierta | UDP directo (host) | ~33 ms | ✅ |
| 2 | Datos móviles (suponiendo que fue el hotspot) | UDP directo (prflx) | 37–178 ms, variable | ✅ |
| 3 | Sin UDP | ICE/TCP (7881) | ~31 ms | ✅ |
| 4 | Sin UDP ni 7881 | **TURN/TLS** | ~33–37 ms | ✅ |
| 5 | Solo TCP 443 | **TURN/TLS** | ~34 ms | ✅ |
| 6 | UDP cortado en plena llamada | UDP → TURN/TLS | 33 ms | ✅ |
