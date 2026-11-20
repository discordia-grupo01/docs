# ADR-044: Los fronts web guardan la sesión en una cookie httpOnly y hablan con el backend a través de un BFF en Next

**Estado:** Aceptada
**Fecha:** 2026-11-20
**Servicios:** `web-client`, `backoffice`, `identify-service`, `gateway`
**Relacionadas:** ADR-006 (API Gateway), ADR-011 (access y refresh token), ADR-014 (tickets de WebSocket), ADR-040 (login con 2FA, PIN y Google), ADR-043 (PIN atado al dispositivo)

## Contexto

Con la ADR-011, un login entrega dos credenciales: un access token JWT que dura 15 minutos y un refresh token que dura 30 días y permite pedir access tokens nuevos sin volver a escribir la contraseña. Los dos tienen que quedar guardados en algún lado del cliente, y quien los tenga en la mano actúa como el usuario. Con el refresh token, además, lo puede hacer durante un mes.

Lo más común en una SPA es guardarlos en `localStorage` y que el JavaScript del navegador los lea para armar el header `Authorization` en cada pedido al gateway. El problema es justamente ese: si el JavaScript de la página puede leer el token, también lo puede leer cualquier script que logre ejecutarse en la página. Basta un XSS, es decir un mensaje, un nombre de servidor o una dependencia de npm que termine inyectando código, para que ese script lea `localStorage` y mande los tokens a otro lado. A partir de ahí el atacante no necesita la sesión del navegador: tiene el refresh token y puede seguir renovando la sesión desde su propia máquina hasta que el token venza o se revoque. Discordia muestra mucho contenido escrito por otros usuarios (mensajes, perfiles, nombres de canales y servidores, emojis), así que es un riesgo real y no teórico.

`identify-service` ya pensaba en esto: el refresh token no viaja en el body de la respuesta del login, sino en una cookie `refresh_token` con `HttpOnly`, `Secure`, `SameSite=Strict` y `Path=/v1/`. Pero esa cookie la pone el dominio del gateway, y el web-client y el backoffice se sirven desde otro dominio (Vercel). Para que el navegador la mande, cada pedido tendría que ser cross-site con credenciales, lo que choca con `SameSite=Strict` y obliga a abrir CORS con credenciales en Kong. Y el access token seguiría necesitando estar en algún lugar legible por JavaScript para armar el header.

La pregunta de este ADR es dónde viven los tokens en los clientes web y por dónde pasan los pedidos al backend.

## Decisión

**Los tokens no se guardan en el navegador de forma accesible para JavaScript. La sesión vive en una cookie `httpOnly` y la única parte que la lee es el servidor de Next.** Así el web-client y el backoffice funcionan como un BFF (*backend for frontend*): el navegador le habla solo a su propio Next, y es Next, del lado del servidor, el que le habla al gateway.

El recorrido de un pedido es así:

```
Navegador ──(cookie discordia_session)──> Next (Route Handler /api/...) ──(Authorization: Bearer <JWT>)──> Kong ──> servicio
```

**El login lo hace Next, no el navegador.** El formulario manda email y contraseña a `POST /api/auth/login`, un Route Handler de Next. Next llama a `POST /v1/login` del gateway, recibe el access token en el body y saca el refresh token del header `Set-Cookie` que pone `identify-service`. Con los dos arma la sesión (access token, refresh token y los datos del usuario) y la escribe en la cookie `discordia_session` con estas opciones:

- `httpOnly`: el JavaScript de la página no la puede leer, así que un XSS no puede robarla.
- `secure` en producción: solo viaja por HTTPS.
- `sameSite: lax`: el navegador no la manda en pedidos `POST` que salgan de otro sitio, lo que corta el CSRF en las rutas que cambian cosas.
- `path: /` y `maxAge` de 30 días, igual que el refresh token. La cookie tiene que vivir lo mismo que él, no los 15 minutos del access token, que se renueva solo.

Al navegador le vuelve solo `{ ok: true, user }`. El JWT y el refresh token no salen nunca del servidor de Next.

**Cada pedido del navegador pasa por un Route Handler de Next.** Bajo `src/app/api/` hay una ruta por cada recurso que usa la app (`/api/servers`, `/api/messages`, `/api/profile`, `/api/billing/...`, etc.). Cada una llama a `getValidSession()`, que lee la cookie y revisa el `exp` del access token. Si le quedan menos de 30 segundos, Next lo renueva con `POST /v1/refresh`, reescribe la cookie y sigue con el token nuevo. Después Next hace el pedido al gateway con `Authorization: Bearer <JWT>` y le devuelve al navegador la respuesta ya traducida a la forma que espera la UI. Como `identify-service` rota el refresh token y trata a uno ya usado como robo (ADR-011), dos pedidos casi simultáneos con el token por vencer podrían cerrar la sesión. Para evitarlo, el resultado de cada refresh se comparte durante 30 segundos entre las rutas que lo pidan con el mismo refresh token.

**El navegador y su Next comparten dominio, así que no hace falta CORS con credenciales.** Los pedidos a `/api/...` salen del mismo origen que la página, y la cookie viaja sola. La cookie `refresh_token` de `identify-service` tampoco tiene que llegar al navegador: la recibe y la usa Next.

**El `middleware.ts` protege las páginas sin ir a la red.** Antes de renderizar, revisa solo que la cookie de sesión tenga la forma correcta: si no la tiene y la página es privada, redirige a `/login`. Si ya hay sesión y la página es de invitado (login, registro), redirige a `/home`. La vigencia real del token la revisa después `getValidSession()`. Si la cookie está corrupta, el middleware la borra para que no quede rebotando entre `/login` y `/home`.

**Hay tres casos en los que el navegador sí le habla directo al gateway, y en los tres usa un ticket de un solo uso, nunca el JWT:**

- **WebSockets** (mensajes, notificaciones y voz). El navegador no puede mandar headers en el handshake, y aunque pudiera no tiene el JWT. Le pide a Next un ticket (`POST /api/realtime/ticket` y equivalentes). Next lo canjea en el backend con el JWT y le devuelve solo el ticket, que va en la URL del socket y dura 30 segundos (ADR-014).
- **Adjuntos.** Vercel corta los pedidos a sus funciones en 4,5 MB, así que un archivo no puede pasar por Next. El navegador pide un ticket de subida (`POST /api/attachments/ticket`, dura 60 segundos) y sube el archivo directo al gateway con él.
- **Voz.** El token de LiveKit también lo pide Next y se lo pasa al navegador, que lo usa solo para conectarse a la sala.

Si uno de estos tickets se filtra, ya está usado o vencido. El JWT y el refresh token siguen sin salir del servidor.

**Otras cookies del BFF siguen la misma idea.** El desafío del segundo factor, entre el paso de la contraseña y el del código (ADR-040), se guarda en la cookie `httpOnly` `discordia_2fa_challenge`, que dura 6 minutos. La única cookie legible por JavaScript es `discordia_account_suspended`. No contiene ninguna credencial: es una marca que Next pone cuando el backend responde `ACCOUNT_SUSPENDED`, para que la UI muestre la pantalla de cuenta suspendida.

**`localStorage` se usa solo para preferencias que no son secretas**: el tema, los mensajes que no se pudieron enviar y qué sección de la configuración quedó abierta. Si un script ajeno las lee, no gana acceso a nada.

**El backoffice hace lo mismo** con su propia cookie y su propio `getValidSession()`. Es el cliente donde más importa: quien robe una sesión del staff puede suspender cuentas y ver expedientes.

**La app móvil no usa este esquema.** No corre en un navegador, así que no hay JavaScript de terceros en una página ni CSRF. Guarda el access token en `expo-secure-store` (el llavero de iOS y el Keystore de Android, marcado como `WHEN_UNLOCKED_THIS_DEVICE_ONLY`), deja que el refresh token viva en el almacén de cookies nativo y le habla directo al gateway.

## Alternativas descartadas

- **Guardar los tokens en `localStorage` o `sessionStorage` y llamar al gateway desde el navegador.** Es lo más simple y no necesita un servidor propio, pero es lo que este ADR quiere evitar: cualquier XSS lee el refresh token y se lleva una sesión que dura 30 días y se puede usar desde afuera del navegador. `sessionStorage` acorta la vida del dato en el navegador, pero no cambia que un script lo pueda leer.
- **Access token solo en memoria (una variable de JavaScript) y refresh token en la cookie de `identify-service`.** Es mejor que `localStorage`, porque el refresh token queda `httpOnly`. Pero exige que el navegador llame al gateway cross-site con credenciales: hay que abrir CORS con `credentials` en Kong y bajar `SameSite=Strict` a `None`, con lo que esa cookie pasa a estar expuesta a CSRF. Además, un XSS puede leer el access token de memoria mientras la página está abierta y, al recargar, la app tiene que pedir un refresh antes de mostrar nada.
- **Servir el front y el gateway bajo el mismo dominio** (por ejemplo, Kong detrás de `/api` del mismo host). Resolvería el problema de las cookies cross-site sin un BFF, pero el front está en Vercel y el gateway en una VM de Oracle (ADR-034), así que habría que poner un proxy delante de los dos. Y el access token seguiría necesitando estar en un lugar legible por JavaScript para armar el header `Authorization`.
- **Sesión opaca en el servidor de Next** (la cookie con solo un id y los tokens en un Redis del front). Es lo más prolijo, porque la cookie no contiene los tokens. Pero suma un almacenamiento compartido que mantener para el front, y en Vercel cada función es efímera. Guardar la sesión en la cookie `httpOnly` da la misma protección contra XSS sin esa infraestructura.

## Consecuencias

Lo que se gana es que un XSS en la web o en el backoffice ya no alcanza para robar la sesión. Un script inyectado puede hacer pedidos a `/api/...` mientras la víctima tiene la página abierta, porque el navegador manda la cookie, pero no puede llevarse los tokens ni usarlos desde otro lado. Al cerrar la pestaña o al hacer logout, el ataque termina. Con `sameSite: lax`, otro sitio tampoco puede disparar acciones con la sesión del usuario.

Además, la UI no sabe nada de tokens, refresh ni rotación: le pega a `/api/...` y Next resuelve la sesión. Las rutas BFF también traducen los errores del backend a mensajes para la UI y dejan una sola forma de respuesta para los componentes. Y como el navegador no habla con el gateway salvo con tickets, Kong no necesita abrir CORS con credenciales.

A cambio, cada pedido hace un salto más (navegador, Next y recién después el gateway), con la latencia que eso suma, y cada endpoint del backend que usa la web necesita su Route Handler en `src/app/api/`. Es código que se repite por cada recurso nuevo. Si Next se cae, se cae todo el acceso de la web aunque el backend esté bien.

La cookie guarda la sesión en JSON sin cifrar. Es `httpOnly`, así que ningún script la lee, pero quien tenga acceso al navegador, a la consola de desarrollo o al disco de la máquina ve los tokens. Es el mismo nivel de exposición que tiene `identify-service` con su cookie `refresh_token`. Además, las cookies tienen un límite de unos 4 KB, así que no se pueden sumar muchos más datos del usuario a la sesión.

`sameSite: lax` deja pasar la cookie en navegaciones `GET` desde otro sitio, así que ninguna ruta `GET` del BFF puede cambiar datos. Todo lo que cambia algo tiene que ir por `POST`, `PUT`, `PATCH` o `DELETE`.

La ventana en la que dos refresh simultáneos no se pisan es por proceso de Node. Si la web corriera en varias instancias sin afinidad de sesión, dos pedidos que caigan en instancias distintas con el token por vencer podrían seguir disparando la detección de reuso de la ADR-011 y cerrar la sesión.

Los tres clientes no autentican igual: la web y el backoffice usan BFF y cookie, y la app móvil usa token y `secure-store`. La lógica que comparten (validaciones, mensajes y forma de los resultados) vive en `client-shared`, pero la sesión se maneja distinto en cada lado.
