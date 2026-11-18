# ADR-006: API Gateway

**Estado:** Aceptado
**Servicios:** `gateway` (Kong y Caddy), todos los servicios detrás
**Relacionadas:** ADR-005 (autenticación), ADR-010 (rate limiting del login), ADR-014 (tickets del WebSocket)

## Contexto

El enunciado pide un API Gateway: un único punto de entrada al sistema que se ocupe de enrutar los pedidos al servicio que corresponde, de validar los tokens de sesión y de limitar la cantidad de pedidos por minuto. Discordia tiene tres clientes, la web, la app móvil y el backoffice, y ninguno debería conocer cómo están repartidos los servicios por dentro ni repetir la lógica de autenticación.

La pregunta de este ADR es qué herramienta usar para ese gateway.

## Decisión

Usamos Kong, y lo usamos en su modo declarativo, que no necesita base de datos: toda su configuración, o sea las rutas, los servicios y los plugins, está en un solo archivo, `kong/kong.yml.template`, que vive en el repositorio `gateway`. Al arrancar, un contenedor completa las variables de ese archivo y Kong lo carga. En producción hay un Caddy delante que pone el HTTPS con un dominio propio.

Kong hace tres cosas. Enruta cada pedido por prefijo de ruta: `/v1/login` va a `identify-service`, `/v1/servers` a `servers`, y así con el resto. Valida el token de sesión con su plugin `jwt`, sin llamar a `identify-service` (ADR-005); las rutas públicas, como el registro, el login o los health checks, no lo llevan. Y limita la velocidad con su plugin `rate-limiting`, por IP: 60 pedidos por minuto en el login y 10 en el refresh, el login por PIN y el de Google, además de topes en otras rutas.

Los servicios más sensibles tienen un `connect_timeout` corto, de 3 segundos en `messaging` y `notifications`, para que una instancia caída no deje a Kong esperando (ADR-016). El WebSocket de `messaging` entra por `/socket` sin token, porque el navegador no puede mandar cabeceras en el handshake, y se autentica con un ticket de un solo uso (ADR-014). Cada vez que se suma un servicio, el CI valida el archivo con `kong config parse`.

## Alternativas descartadas

Las alternativas son otras herramientas que podrían haber sido el gateway.

- **Un gateway propio, escrito en Go.** Daría control total, pero habría que programar a mano la validación de tokens, el límite de pedidos y el enrutamiento, que las herramientas maduras ya resuelven.
- **Nginx como reverse proxy.** Es liviano y muy conocido, pero no trae validación de JWT ni límite de pedidos pensados para APIs, y habría que sumarle módulos o código en Lua.
- **Traefik.** Se integra muy bien con Docker y Kubernetes, pero está menos orientado a la autenticación de APIs que Kong.

Elegimos Kong porque trae todo lo que pide el enunciado como plugins ya hechos, y porque su modo declarativo nos deja versionar la configuración en Git y revisarla en un pull request, sin sumar una base de datos que mantener.

## Consecuencias

Los clientes hablan con un solo host y no conocen cómo está repartido el backend. La autenticación y el límite de pedidos quedan en un lugar y no se repiten en cada servicio, y como la configuración es un archivo, los cambios de rutas se revisan como cualquier otro cambio de código.

A cambio, Kong es un punto único de falla: si cae, cae todo el acceso externo. Hoy corre una sola instancia en una VM de Oracle, y para evitarlo habría que levantar varias detrás de un balanceador. Cualquier cambio de ruta, o cambiar el secreto con que se firman los tokens, obliga a actualizar el archivo y reiniciar Kong, y cada pedido paga una capa más de latencia. Además, como el límite de velocidad cuenta por instancia, con varias instancias el tope efectivo sería mayor.
