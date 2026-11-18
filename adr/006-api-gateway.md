# ADR-006: API Gateway

**Estado:** Esperando aceptación

## Contexto

El enunciado exige un API Gateway como punto único de entrada al sistema, que centralice el enrutamiento hacia los servicios backend, la validación de tokens de sesión y el rate limiting, con su diseño justificado en un ADR. Discordia expone tres clientes (web, mobile, backoffice) que no deben conocer la topología interna de los microservicios ni duplicar lógica de autenticación en cada uno. Se evaluaron alternativas: Un gateway propio escrito en Go (control total, pero reimplementar JWT/rate-limiting/routing que ya resuelven herramientas maduras), Nginx como reverse proxy manual (liviano pero sin validación de JWT ni rate limiting nativos, requiere módulos o Lua custom), Traefik (buena integración con Docker/K8s pero menos foco en autenticación de API que Kong) y **Kong** (sugerido por la cátedra, con plugins nativos de JWT, rate limiting y logging, y configuración declarativa versionable en Git).

## Decisión

Adoptar **Kong** como API Gateway único, en **modo declarativo (DB-less)**: La configuración de Services, Routes y Plugins vive como `kong.yml` versionado en `discordia-gateway`, sin necesidad de una base de datos propia para Kong (resuelve la duda de "Postgres o Cassandra" del stack: no hace falta ninguna).

- **Enrutamiento**: Por prefijo de path hacia el servicio correspondiente (`/api/v1/auth/*` → discordia-identify, `/api/v1/servers/*` y `/api/v1/channels/*` → discordia-servers, etc.), usando Kong Routes + Services.
- **Autenticación**: Plugin `jwt` de Kong, validando localmente con HS256 y el secreto compartido `JWT_SECRET` con que firma discordia-identify (ver ADR-005), Kong nunca llama al servicio de identidad para validar un token.
- **Rate limiting**: Plugin `rate-limiting` aplicado por IP y por consumer en los endpoints de login y recupero de contraseña (requisito explícito del enunciado).
- **Resiliencia**: Timeouts y reintentos configurados hacia los backends para no propagar cascadas de fallo cuando un servicio está degradado.

## Consecuencias

- **Positivas**:
    - Los clientes hablan con un único host; no conocen ni versionan la topología interna de microservicios.
    - Autenticación y rate limiting quedan centralizados, en vez de reimplementarse en cada uno de los servicios.
    - Configuración declarativa (`kong.yml`) queda versionada y revisable en PRs, igual que cualquier otro contrato.
    - Modo DB-less elimina un componente de infraestructura (no hay que correr ni mantener una base para Kong).
- **Negativas**:
    - Kong es un punto único de falla: Si cae, cae todo el acceso externo al sistema, se mitiga corriendo varias instancias detrás de un balanceador.
    - Cualquier cambio de ruta o rotación de la clave JWT requiere actualizar y redeployar `kong.yml`.
    - Suma una capa extra de latencia por request y un proceso más compitiendo por RAM en el VM de infra.
    - El equipo necesita aprender la configuración de Kong (Services/Routes/Plugins), aunque la curva es baja comparada con mantener un gateway propio.

## Nota de actualización (2026-11-18)

El texto original hablaba de una clave pública RSA. La configuración real (`kong.yml.template`, `jwt_secrets` con `algorithm: HS256` y `secret: ${JWT_SECRET}`) usa HS256 con secreto compartido; se corrigió la línea de Autenticación. La rotación del secreto (consecuencia ya listada) implica actualizar `JWT_SECRET` en Kong y en todos los servicios que validan el token. Además, después de este ADR se sumó un plugin `post-function` global que reescribe los errores generados por Kong al formato de error común (ver ADR-029).
