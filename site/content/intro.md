## De qué trata el proyecto

**Discordia** es una plataforma de comunidades en línea, al estilo de Discord: cada persona se registra, crea o se une a **servidores**, que se organizan en **canales de texto y de voz**, con **roles y permisos**, **mensajes directos**, **notificaciones** (también push), **moderación** y un plan **Premium** que se paga con Mercado Pago. El personal de la plataforma tiene su propio **backoffice** para suspender cuentas y servidores y ver métricas.

Se construyó como trabajo práctico de **Ingeniería de Software 2** (FIUBA, 2C2026) y está pensado como un sistema real: ocho servicios backend independientes que se comunican por eventos, un gateway como única puerta de entrada, y tres clientes (web, app móvil y backoffice).

## Cómo está armado

- **Servicios:** `identify-service`, `servers`, `messaging`, `notifications`, `billing`, `admin`, `metrics` y `voice-sfu`, en Go y en Elixir. Cada uno tiene su propia base de datos (PostgreSQL o MongoDB).
- **Comunicación:** los servicios se avisan los cambios por RabbitMQ, con un patrón *outbox* para no perder eventos. Los clientes hablan solo con el gateway (Kong), por REST y WebSocket. El audio va directo a LiveKit.
- **Clientes:** una web en Next.js, una app móvil en React Native y un backoffice para el staff.

## Qué hay en este sitio

Cada sección sale de los repositorios y se actualiza sola:

- **ADRs:** las decisiones de arquitectura, con su contexto y sus alternativas.
- **Diagramas:** los diagramas C4 (contexto, contenedores y componentes), el despliegue y los flujos principales.
- **OpenAPI:** la API REST de cada servicio, leída de su repositorio.
- **AsyncAPI:** los eventos que viajan por RabbitMQ y quién los publica y los consume.
- **Operación:** cómo se reintentan los eventos fallidos y otros documentos para operar el sistema.

## Quiénes lo hicieron

