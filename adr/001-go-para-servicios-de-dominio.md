# ADR-001: Selección de Go para los Servicios de Dominio

**Estado:** Aceptado

## Contexto

Se requiere implementar los microservicios transaccionales del núcleo de negocio (Usuarios, Perfil, Servidores, Canales, Roles y Permisos, Moderación, Administración, Métricas y Monetización). Se evaluaron alternativas como Java (con la cual el equipo contaba con experiencia previa en el desarrollo de la API de cafetería) y Python. Si bien Java ofrece un ecosistema sumamente maduro y Python rapidez de desarrollo, el sistema demanda baja latencia, bajo consumo de memoria RAM por contenedor y alta eficiencia en operaciones I/O concurrentes.

## Decisión

Adoptar Go como lenguaje principal junto con el framework Gin para la construcción de todos los microservicios de dominio transaccional.

## Consecuencias

- **Positivas:**
    - Elevado desempeño y rendimiento I/O impulsado por el modelo de concurrencia nativo mediante *goroutines*.
    - Curva de aprendizaje ágil para el equipo gracias a la simplicidad sintáctica del lenguaje.
- **Negativas:**
    - Manejo explícito y continuo de errores que resulta en mayor verbosidad del código frente a Java o Python.
    - Ausencia de herencia orientada a objetos tradicional
