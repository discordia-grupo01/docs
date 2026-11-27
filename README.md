# docs

Documentación central de Discordia.

## Tabla de contenidos

- [Introducción](#introducción)
- [Pre-requisitos](#pre-requisitos)
- [Cómo correr](#cómo-correr)
- [Variables de entorno](#variables-de-entorno)
- [Comandos Docker](#comandos-docker)
- [Tests](#tests)
- [Más documentación](#más-documentación)

## Introducción

Este repositorio reúne la documentación que no pertenece a un solo servicio: cómo se comunican entre sí. No tiene código ni se despliega.

Hoy tiene dos tipos de documentos:

- **Los AsyncAPI** (carpeta [`asyncapi`](asyncapi)): describen cada evento que viaja por RabbitMQ, con quién lo publica, quién lo consume y qué hace con él. Hay un archivo por dominio:

| Archivo | Qué describe |
|---|---|
| [`asyncapi.yaml`](asyncapi/asyncapi.yaml) | Membresía: altas, bajas y bans de miembros de un servidor. |
| [`channels.yaml`](asyncapi/channels.yaml) | Canales: alta y baja de canales y de servidores, y emojis. |
| [`permissions.yaml`](asyncapi/permissions.yaml) | Roles, permisos y dueño del servidor, que `messaging` replica para autorizar sin consultar a `servers`. |
| [`messages.yaml`](asyncapi/messages.yaml) | Actividad de mensajería, que `notifications` usa para los no leídos, el historial y el push. |
| [`admin.yaml`](asyncapi/admin.yaml) | Suspensiones y recuperación de cuentas por el staff, con eventos firmados. |
| [`billing.yaml`](asyncapi/billing.yaml) | Estado de Premium de cada usuario, con eventos firmados. |
| [`boosts.yaml`](asyncapi/boosts.yaml) | La saga entre `billing` y `servers` para boostear un servidor. |
| [`messaging-broadcast.yaml`](asyncapi/messaging-broadcast.yaml) | El canal interno por el que las instancias de `messaging` se pasan los mensajes. Se genera solo, no se edita a mano. |

- **Los documentos de decisiones y de operación**, en la raíz: cómo se reintentan y se apartan los eventos que fallan ([`reintentos-y-dlq.md`](reintentos-y-dlq.md)) y cómo `voice-sfu` pasó a autorizar con su propia copia de datos ([`voice-replica-migration.md`](voice-replica-migration.md)).

Todo esto se publica como un sitio con la introducción del proyecto, los ADRs, los diagramas C4, los OpenAPI de los servicios y los AsyncAPI: <https://discordia-grupo01.github.io/docs/>. Se genera solo desde este repositorio (carpeta [`site`](site)) y desde la rama `main` de cada servicio.

Los campos, tipos y formatos de cada evento los define el repositorio [`events-contract`](https://github.com/discordia-grupo01/events-contract), y de ahí salen los schemas. Acá se explica el sentido de cada evento. Para que las dos cosas no se separen, el CI compara estos archivos contra el contrato.

## Pre-requisitos

- **Go 1.22**, para comparar los AsyncAPI con el contrato.
- **Node.js 22**, para validarlos con la herramienta oficial de AsyncAPI.
- **Docker**, solo si preferís correr esos chequeos sin instalar Go.

## Cómo correr

No se corre: se edita y se valida. Antes de abrir un pull request, conviene comprobar que los AsyncAPI sigan coincidiendo con el contrato.

Comparar con `events-contract`:

```bash
go run github.com/discordia-grupo01/events-contract/cmd/eventsgen@latest docs-check asyncapi
```

Si hay diferencias en los schemas, el mismo programa los regenera:

```bash
go run github.com/discordia-grupo01/events-contract/cmd/eventsgen@latest docs-sync asyncapi
```

`docs-sync` solo actualiza los schemas. La explicación de cada evento se escribe a mano. Para que no se atrase, un workflow semanal corre `docs-sync` y abre un pull request si algo cambió.

Generar el sitio y verlo en local (necesita Node.js 22). Con `build:local` los OpenAPI se leen de los repositorios hermanos; con `build` se descargan de GitHub:

```bash
cd site
npm ci
npm run build:local
```

El resultado queda en `site/dist`.

Validar el formato de cada archivo con la herramienta de AsyncAPI:

```bash
for f in asyncapi/*.yaml; do npx --yes @asyncapi/cli@2 validate "$f"; done
```

## Variables de entorno

No usa ninguna.

## Comandos Docker

No tiene `docker-compose.yml`: no es un servicio. Para correr la comparación con el contrato sin instalar Go:

```bash
docker run --rm -v "$PWD":/app -w /app golang:1.22-alpine sh -c \
  "apk add --no-cache git >/dev/null && go run github.com/discordia-grupo01/events-contract/cmd/eventsgen@latest docs-check asyncapi"
```

## Tests

No tiene tests propios. En cada pull request, en cada push a `develop` o `main` y una vez por semana, el CI hace dos cosas:

- Compara los AsyncAPI con `events-contract` (`docs-check`) y falla si los schemas no coinciden con el contrato.
- Valida cada archivo con la herramienta oficial de AsyncAPI.

## Más documentación

- [`events-contract`](https://github.com/discordia-grupo01/events-contract): el contrato de los eventos, de donde salen los schemas.
- El README de cada servicio explica qué eventos publica y consume.
- [`manuales`](manuales/README.md): las guías de usuario de las aplicaciones, empezando por la app mobile.
