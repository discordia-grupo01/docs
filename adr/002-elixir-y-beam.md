# ADR-002: Adopción de Elixir y BEAM para Mensajería, Notificaciones y Señalización

**Estado:** Esperando aceptación

## Contexto

La plataforma requiere procesar comunicación bidireccional en tiempo real con alta densidad de conexiones persistentes (WebSockets) para los módulos de Mensajería, Notificaciones y Señalización de Voz. La arquitectura probada de plataformas como Discord demuestra la eficiencia de la máquina virtual de Erlang (BEAM) para sostener alto volumen de conexiones concurrentes con baja latencia y tolerancia a fallos.

## Decisión

Adoptar Elixir junto con el framework Phoenix (y Phoenix Channels) para los servicios de Mensajería, Notificaciones y la capa de Señalización de Voz.

## Consecuencias

- **Positivas:**
    - Capacidad nativa de gestionar miles de conexiones concurrentes por nodo con escaso impacto en memoria y CPU.
    - Tolerancia a fallos por diseño mediante el modelo de actores
    - Abstracción simplificada para canales bidireccionales en tiempo real mediante Phoenix Channels.
- **Negativas:**
    - Curva de aprendizaje requerida para adaptar al equipo al paradigma de programación funcional.
    - Menor disponibilidad de librerías de terceros en comparación con ecosistemas como Java o Go.
