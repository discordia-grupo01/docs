# ADR-001: Selección de Go para los servicios de dominio

**Estado:** Aceptado
**Servicios:** `identify-service`, `servers`, `billing`, `admin`, `metrics`
**Relacionadas:** ADR-002 (Elixir para el tiempo real)

## Contexto

Había que implementar los servicios transaccionales del núcleo del negocio: usuarios y perfiles, servidores, canales, roles y permisos, moderación, administración, métricas y monetización. Son servicios con mucho acceso a bases relacionales, muchos pedidos HTTP concurrentes y bastante lógica de reglas, pero sin conexiones persistentes de larga duración.

La consigna pide usar al menos dos lenguajes, así que había que elegir uno para estos servicios y otro para el tiempo real. Las alternativas que miramos para los servicios de dominio fueron Java, con la que el equipo ya había trabajado en la API de cafetería de la cursada, y Python. Java tiene un ecosistema maduro y Python permite avanzar rápido. Pero queríamos servicios con baja latencia, poco consumo de memoria por contenedor, porque corren en VMs chicas de planes gratuitos, y buen manejo de operaciones de entrada y salida concurrentes.

## Decisión

Usamos Go, con el framework Gin, para todos los servicios de dominio transaccional. Hoy son cinco: `identify-service`, `servers`, `billing`, `admin` y `metrics`.

## Alternativas descartadas

- **Java.** El equipo tiene experiencia y el ecosistema es muy maduro, pero un servicio en la JVM consume bastante más memoria al arrancar y tarda más en levantar, algo que pesa cuando todo el sistema corre en máquinas chicas.
- **Python.** Es muy rápido para desarrollar, pero su rendimiento con muchos pedidos concurrentes es menor, y los tipos dinámicos hacen más fácil que los errores aparezcan en producción y no al compilar.

## Consecuencias

Ganamos un rendimiento muy bueno en operaciones concurrentes gracias a las goroutines, contenedores chicos y rápidos de arrancar, y una curva de aprendizaje corta para el equipo, porque el lenguaje es simple.

A cambio, el manejo explícito de errores hace el código más extenso que en Java o Python, y Go no tiene herencia orientada a objetos tradicional, lo que obliga a pensar los diseños de otra manera.
