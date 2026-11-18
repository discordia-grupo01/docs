# ADR-034: Dónde corre cada servicio y cómo se despliega

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** todos, con `rabbit-mq`, `gateway` e `infrastructure`
**Relacionadas:** ADR-004 (bases de datos), ADR-006 (API Gateway), ADR-007 (pub/sub), ADR-009 (archivos), ADR-023 (observabilidad), ADR-036 (CI/CD)

## Contexto

Discordia está formada por ocho servicios de backend, un gateway, un bus de eventos, tres aplicaciones cliente y varias bases de datos, y tenemos que desplegar todo con planes gratuitos. Ninguna plataforma gratuita alcanza para todo junto, y cada pieza tiene necesidades distintas: la web es una aplicación de Next.js, la voz necesita puertos UDP para el audio, los WebSockets necesitan procesos de larga duración y RabbitMQ necesita un disco propio y una dirección estable.

## Decisión

Repartimos las piezas entre varias plataformas gratuitas, aprovechando lo que ofrece cada una, y las conectamos por Internet con HTTPS y, para el bus de eventos, por una red privada de Tailscale.

| Plataforma | Qué corre ahí | Ventajas | Desventajas |
|---|---|---|---|
| Oracle Cloud | `gateway`, `rabbit-mq`, `messaging`, `billing`, `admin` y el servidor de desarrollo de la app | 2 VMs gratis y siempre gratis (*always free*) | Su política detecta el uso de varias cuentas o el uso indebido, y puede suspenderlas |
| Google Cloud | `identify-service` y `servers` | 1 VM gratis y siempre gratis | Para tener más capacidad hay que crear muchas cuentas |
| Render | `notifications` y `metrics` | 1 servicio gratis y siempre gratis | Se duerme por inactividad; lo evitamos haciéndole un ping periódico a `/health` |
| Fly.io | `voice-sfu` (señalización) y LiveKit | 1 máquina gratis y siempre gratis | |
| Vercel | `web-client` y `backoffice` | Gratis para siempre | El plan gratuito no permite uso de producción real |
| Supabase | Bases de Postgres y almacenamiento de archivos | 2 proyectos gratis para siempre, con 1 GB por proyecto | Solo dos proyectos, así que compartimos uno con un schema por servicio (ADR-004) |
| MongoDB Atlas | Bases de Mongo | 1 proyecto gratis para siempre | Un solo proyecto para los dos servicios que usan Mongo |
| Cloudinary | Adjuntos chicos | Plan gratuito con entrega por CDN | Tope de 10 MB por archivo (ADR-009) |
| New Relic | Trazas, métricas y logs | 100 GB de ingesta al mes gratis, sin vencimiento | Al pasar el límite deja de recibir datos hasta el mes siguiente (ADR-023) |

La app móvil se publica con Expo. Los servicios de las VMs se despliegan con Docker. Al llegar un cambio a `main` y pasar el CI, un workflow entra por SSH a la VM y actualiza el contenedor; en el caso de `rabbit-mq` hace `git pull` y `docker compose up -d`. `notifications` y `metrics` en Render se despliegan solos cuando pasan los checks, y la web en Vercel con cada cambio.

RabbitMQ lo operamos nosotros, en la VM de Oracle y con su propio volumen, en lugar de usar un servicio administrado (ADR-007). Los servicios que están en otras plataformas, como `notifications` en Render, llegan a él a través de Tailscale, con un puente local en el contenedor. El puerto de administración queda publicado solo en la propia VM.

## Alternativas descartadas

- **Todo en una sola nube.** Las capas gratuitas de una sola plataforma no alcanzan para ocho servicios, tres aplicaciones, RabbitMQ y las bases al mismo tiempo.
- **Todo en una sola VM con Docker Compose.** Es lo más simple de operar, pero la VM sería un punto único de falla para todo, y las VMs gratuitas tienen poca memoria.
- **RabbitMQ en CloudAMQP.** Evitaría operarlo, pero su plan gratuito limita las conexiones simultáneas a 20 (ADR-007).

Kubernetes quedó fuera por ahora. Nos pareció una opción para más adelante, si el sistema crece, pero no lo probamos: es mucha infraestructura para operar con planes gratuitos.

## Consecuencias

Cada pieza corre donde mejor encaja y el costo es nulo, y si una plataforma falla o cambia sus límites solo se ven afectados los servicios que corren ahí.

A cambio, hay mucha superficie para operar: varias cuentas, credenciales y mecanismos de despliegue distintos, y si una plataforma cambia o quita su plan gratuito hay que mover los servicios. Dependemos además de las condiciones de cada una: Oracle puede suspender una cuenta que su política considere sospechosa, Render duerme el servicio si deja de recibir pedidos, y Vercel no permite el plan gratuito para producción real, lo que es una condición que hoy aceptamos para un proyecto académico. La red entre plataformas es la pública, con HTTPS, salvo RabbitMQ, que va por Tailscale. Y que RabbitMQ lo mantengamos nosotros nos obliga a cuidar su configuración.

En noviembre de 2026 lo comprobamos de la peor manera: cambiar el `healthcheck` del `docker-compose.yml` hizo que Compose recreara el contenedor, y como RabbitMQ toma el nombre de su nodo del hostname del contenedor, arrancó como un nodo nuevo, sin el usuario que usaban varios servicios ni las colas. `messaging`, `notifications`, `voice-sfu`, `metrics` y `billing` quedaron unas 30 horas sin conectarse, mientras los otros servicios seguían funcionando. Lo resolvimos fijando el hostname del nodo original en `docker-compose.yml` y documentando por qué no hay que cambiarlo. Siguen pendientes una alerta por conexiones fallidas y un chequeo después de cada despliegue que verifique que existan el usuario y las colas.
