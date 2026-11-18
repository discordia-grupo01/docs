# ADR-002: Adopción de Elixir y BEAM para mensajería, notificaciones y señalización

**Estado:** Aceptado
**Servicios:** `messaging`, `notifications`, `voice-sfu` (señalización)
**Relacionadas:** ADR-001 (Go para los servicios de dominio), ADR-016 (propagación entre instancias)

## Contexto

La plataforma tiene que sostener comunicación bidireccional en tiempo real con muchas conexiones persistentes, los WebSockets, en tres lugares: la mensajería, las notificaciones y la señalización de voz. Plataformas como Discord muestran que la máquina virtual de Erlang, BEAM, sostiene un volumen muy alto de conexiones concurrentes con baja latencia y se recupera bien de los fallos.

## Decisión

Usamos Elixir con el framework Phoenix, y en particular Phoenix Channels, para `messaging`, `notifications` y la capa de señalización de `voice-sfu`.

## Alternativas descartadas

- **Rust.** Es muy eficiente y seguro, pero tiene una curva de aprendizaje muy pronunciada para un equipo que recién empieza con él, y no trae algo equivalente a Phoenix Channels: habría que armar a mano la gestión de conexiones, de temas de suscripción y de reconexión.
- **Node.js con Socket.IO.** Es muy conocido y rápido de arrancar, pero un solo hilo de ejecución por proceso complica sostener muchas conexiones con mucha actividad, y los fallos de una conexión pueden afectar a las demás.

## Consecuencias

Ganamos capacidad de manejar miles de conexiones concurrentes por nodo con poco consumo de memoria y CPU, tolerancia a fallos por diseño gracias al modelo de actores, donde la caída de una conexión no arrastra a las demás, y una abstracción sencilla para los canales bidireccionales con Phoenix Channels.

El costo es una curva de aprendizaje real para un equipo que no venía de la programación funcional, y un ecosistema de librerías de terceros más chico que el de Java o Go.
