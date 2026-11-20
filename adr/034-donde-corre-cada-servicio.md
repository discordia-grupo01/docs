# ADR-034: Dónde corre cada servicio y cómo se despliega

**Estado:** Aceptada
**Fecha:** 2026-11-18, actualizada el 2026-11-20 (`notifications` pasó de Render a Oracle)
**Servicios:** todos, con `rabbit-mq`, `gateway` e `infrastructure`
**Relacionadas:** ADR-004 (bases de datos), ADR-006 (API Gateway), ADR-007 (pub/sub), ADR-009 (archivos), ADR-023 (observabilidad), ADR-036 (CI/CD)

## Contexto

Discordia está formada por ocho servicios de backend, un gateway, un bus de eventos, tres aplicaciones cliente y varias bases de datos, y tenemos que desplegar todo con planes gratuitos. Ninguna plataforma gratuita alcanza para todo junto, y cada pieza tiene necesidades distintas: la web es una aplicación de Next.js, la voz necesita puertos UDP para el audio, los WebSockets necesitan procesos de larga duración y RabbitMQ necesita un disco propio y una dirección estable.

## Decisión

Repartimos las piezas entre varias plataformas gratuitas, aprovechando lo que ofrece cada una, y las conectamos por Internet con HTTPS y, para el bus de eventos, por una red privada de Tailscale.

| Plataforma | Qué corre ahí | Ventajas | Desventajas |
|---|---|---|---|
| Oracle Cloud | `gateway`, `rabbit-mq`, `messaging`, `billing`, `admin`, `notifications` y el servidor de desarrollo de la app | 2 VMs gratis y siempre gratis (*always free*) por cuenta | Su política detecta el uso de varias cuentas o el uso indebido, y puede suspenderlas. `notifications` corre en una VM aparte, creada en la cuenta de un integrante del equipo |
| Google Cloud | `identify-service` y `servers` | 1 VM gratis y siempre gratis | Para tener más capacidad hay que crear muchas cuentas |
| Render | `metrics` | 1 servicio gratis y siempre gratis | Se duerme por inactividad; lo evitamos haciéndole un ping periódico a `/health`. Además incluye solo 5 GB de salida de datos por mes, y al pasarse suspende el servicio hasta el mes siguiente (ver Consecuencias) |
| Fly.io | `voice-sfu` (señalización) y LiveKit | 1 máquina gratis y siempre gratis | |
| Vercel | `web-client` y `backoffice` | Gratis para siempre | El plan gratuito no permite uso de producción real |
| Supabase | Bases de Postgres y almacenamiento de archivos | 2 proyectos gratis para siempre, con 1 GB por proyecto | Solo dos proyectos, así que compartimos uno con un schema por servicio (ADR-004) |
| MongoDB Atlas | Bases de Mongo | 1 proyecto gratis para siempre | Un solo proyecto para los dos servicios que usan Mongo |
| Cloudinary | Adjuntos chicos | Plan gratuito con entrega por CDN | Tope de 10 MB por archivo (ADR-009) |
| New Relic | Trazas, métricas y logs | 100 GB de ingesta al mes gratis, sin vencimiento | Al pasar el límite deja de recibir datos hasta el mes siguiente (ADR-023) |

La app móvil se publica con Expo. Los servicios de las VMs se despliegan con Docker. Al llegar un cambio a `main` y pasar el CI, un workflow entra por SSH a la VM y actualiza el contenedor; en el caso de `rabbit-mq` hace `git pull` y `docker compose up -d`. `metrics` en Render se despliega solo cuando pasa los checks, y la web en Vercel con cada cambio. `notifications` publica su imagen en Docker Hub al llegar a `main`, pero el despliegue en su VM todavía es manual: se corre `~/deploy.sh` con la imagen nueva, que baja el contenedor, espera a que `/readyz` responda y vuelve a la versión anterior si falla.

RabbitMQ lo operamos nosotros, en la VM de Oracle y con su propio volumen, en lugar de usar un servicio administrado (ADR-007). Los servicios que están en otras plataformas, como `metrics` en Render y `notifications` en su VM aparte, llegan a él a través de Tailscale, con un puente local en el contenedor. El puerto de administración queda publicado solo en la propia VM.

## Alternativas descartadas

- **Todo en una sola nube.** Las capas gratuitas de una sola plataforma no alcanzan para ocho servicios, tres aplicaciones, RabbitMQ y las bases al mismo tiempo.
- **Todo en una sola VM con Docker Compose.** Es lo más simple de operar, pero la VM sería un punto único de falla para todo, y las VMs gratuitas tienen poca memoria.
- **RabbitMQ en CloudAMQP.** Evitaría operarlo, pero su plan gratuito limita las conexiones simultáneas a 20 (ADR-007).

Kubernetes quedó fuera por ahora. Nos pareció una opción para más adelante, si el sistema crece, pero no lo probamos: es mucha infraestructura para operar con planes gratuitos.

## Consecuencias

Cada pieza corre donde mejor encaja y el costo es nulo, y si una plataforma falla o cambia sus límites solo se ven afectados los servicios que corren ahí.

A cambio, hay mucha superficie para operar: varias cuentas, credenciales y mecanismos de despliegue distintos, y si una plataforma cambia o quita su plan gratuito hay que mover los servicios. Dependemos además de las condiciones de cada una: Oracle puede suspender una cuenta que su política considere sospechosa, Render duerme el servicio si deja de recibir pedidos, y Vercel no permite el plan gratuito para producción real, lo que es una condición que hoy aceptamos para un proyecto académico. La red entre plataformas es la pública, con HTTPS, salvo RabbitMQ, que va por Tailscale. Y que RabbitMQ lo mantengamos nosotros nos obliga a cuidar su configuración.

En noviembre de 2026 lo comprobamos de la peor manera: cambiar el `healthcheck` del `docker-compose.yml` hizo que Compose recreara el contenedor, y como RabbitMQ toma el nombre de su nodo del hostname del contenedor, arrancó como un nodo nuevo, sin el usuario que usaban varios servicios ni las colas. `messaging`, `notifications`, `voice-sfu`, `metrics` y `billing` quedaron unas 30 horas sin conectarse, mientras los otros servicios seguían funcionando. Lo resolvimos fijando el hostname del nodo original en `docker-compose.yml` y documentando por qué no hay que cambiarlo. Siguen pendientes una alerta por conexiones fallidas y un chequeo después de cada despliegue que verifique que existan el usuario y las colas.

El 20 de noviembre de 2026 encontramos otra desventaja de Render que no habíamos previsto: el plan gratuito incluye solo 5 GB de salida de datos por mes y por workspace. `notifications` los consumió antes de fin de mes y Render lo suspendió hasta que el cupo se renueve, así que se cayeron los avisos push, los no leídos y los avisos de cambio en tiempo real. Casi todo ese tráfico no eran respuestas a los usuarios, que sumaron unos 36 MB, sino conexiones que el propio servicio inicia hacia afuera, y su salida era pareja a lo largo del día aunque nadie lo usara. No encontramos qué la genera. Mirábamos las horas de instancia y la memoria, pero no el ancho de banda, y es un límite que solo aparece cuando ya se cumplió.

Lo resolvimos moviendo `notifications` a una VM de Oracle, donde no hay un tope de salida que nos alcance, con la imagen publicada en Docker Hub como la de `messaging`. `metrics` sigue en Render y no se vio afectado. Quedan pendientes averiguar qué genera ese tráfico, una alerta antes de llegar al límite, y automatizar el despliegue de `notifications`, que hoy es manual.
