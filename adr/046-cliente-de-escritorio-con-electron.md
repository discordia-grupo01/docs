# ADR-046: El cliente de escritorio es una ventana de Electron que carga el web-client desplegado

**Estado:** Propuesta
**Fecha:** 2026-11-27
**Servicios:** `web-client`, `backoffice`
**Relacionadas:** ADR-003 (voz en tiempo real), ADR-034 (dónde corre cada servicio), ADR-040 (login con 2FA, PIN y Google), ADR-044 (sesión web en cookies y BFF)

## Contexto

El enunciado deja como optativo un cliente de escritorio, armado a partir del cliente web con Electron u otra tecnología equivalente. La idea es que Discordia se instale como un programa propio, con su ícono y su ventana, sin abrir el navegador.

El web-client no es una SPA estática. Es una app de Next con Route Handlers en `src/app/api/` que funcionan como BFF (ADR-044): leen la cookie `httpOnly` de la sesión, renuevan el access token y recién después le pegan al gateway. Eso necesita un servidor de Node corriendo, así que no se puede exportar a HTML estático y meterlo en un instalador. Hoy ese servidor es Vercel, en `https://discordia-g1.vercel.app` (ADR-034).

Además, Discordia no tiene nada que hacer sin conexión. Los mensajes, los servidores, los perfiles y la voz viven en el backend. Sin red se puede mostrar una pantalla, pero no iniciar sesión ni leer nada.

La pregunta de este ADR es con qué tecnología se arma el cliente de escritorio y de dónde saca la interfaz.

## Decisión

**El cliente de escritorio es una app de Electron que abre una ventana y carga la URL del web-client desplegado.** El código vive en `web-client/desktop/`, con su propio `package.json`, separado de las dependencias de Next. Es un solo archivo, `main.js`, que hace lo siguiente:

- Abre una ventana de 1280 x 800 sin barra de menú y carga `https://discordia-g1.vercel.app`. En desarrollo carga `http://localhost:3000`, y con la variable de entorno `DISCORDIA_URL` se puede apuntar a cualquier otra.
- Corre la página con `contextIsolation`, `sandbox` y sin `nodeIntegration`. La web no tiene acceso a Node ni al sistema de archivos: se comporta igual que en un navegador.
- Deja abrir dentro de la app solo el popup de `accounts.google.com`, que es el que usa el botón de Google (ADR-040). Cualquier otro link que abra una ventana nueva, como un adjunto o un link de un mensaje, se abre en el navegador del sistema.
- Da permisos solo a la web de Discordia y solo los que usa: micrófono para la voz de LiveKit (ADR-003), notificaciones, pantalla completa y portapapeles.
- Permite una sola instancia: si se abre de nuevo, enfoca la ventana que ya estaba.

**La sesión funciona igual que en el navegador.** La ventana es un Chromium que guarda cookies, así que la cookie `discordia_session` del BFF se guarda en el perfil de la app y no cambia nada de la ADR-044.

**Sin conexión se muestra una pantalla propia, no la página de error de Chromium.** Hay dos casos:

- **La app se abre sin red.** La URL no carga y Electron recibe `did-fail-load`. En ese caso carga `desktop/offline.html`, una página local con el logo animado y el texto "Sin conexión. Reintentando…". La página vuelve a probar la URL cada 5 segundos y cada vez que el sistema avisa que volvió la red. Cuando responde, navega a la app. Es HTML sin dependencias porque se abre justamente cuando no se puede descargar nada.
- **Se corta la red con la app abierta.** Lo resuelve la web: el web-client y el backoffice muestran la misma pantalla encima de todo mientras `navigator.onLine` sea falso, y la sacan cuando vuelve. Como eso vive en la web, también lo ve quien usa Discordia desde el navegador. En el backoffice el logo y la animación son los mismos, sobre el fondo propio del panel.

**Los instaladores los arma `electron-builder`**: `npm run dist:linux` genera un AppImage y un `.deb`, y `npm run dist:win` un instalador NSIS para Windows. Quedan en `desktop/dist/`, que está en el `.gitignore`. `desktop/` también está en el `.dockerignore`, para que la imagen del web-client no copie Electron.

## Alternativas descartadas

- **Meter el servidor de Next dentro de la app.** Se compila Next con `output: "standalone"` y Electron lo levanta en un puerto de `localhost` al arrancar. La interfaz queda fija en el instalador y no depende de Vercel. Pero sin backend tampoco funciona sin conexión, así que la ventaja es chica. A cambio, hay que manejar el puerto, pasarle al proceso las variables de entorno del servidor (URL del gateway, secretos de la sesión), y el instalador pesa bastante más. Además, cada cambio en la web obliga a sacar una versión nueva de escritorio, y los usuarios que no actualicen quedan con una UI vieja contra un backend que ya cambió.
- **Exportar el web-client a HTML estático y cargarlo desde disco.** No se puede: las rutas de `src/app/api/` necesitan un servidor, y sin el BFF habría que volver a guardar los tokens en el navegador, que es lo que la ADR-044 descartó.
- **Tauri.** Genera instaladores mucho más chicos porque usa el motor web del sistema operativo en vez de traer Chromium. Pero eso hace que la app se vea y se comporte distinto en cada sistema: en Linux usa WebKitGTK, que tiene diferencias en WebRTC y en los permisos de micrófono, justo lo que necesita la voz. También suma Rust al proyecto, que no usa nadie del equipo. El enunciado nombra Electron, y con él la ventana es el mismo Chromium en todos lados.
- **Una PWA instalable.** Chrome y Edge dejan instalar la web como app sin escribir nada de escritorio. Es lo más barato, pero no es un programa que se reparta: cada usuario tiene que instalarla desde el navegador, no hay instalador ni `.deb`, y Firefox y Safari en escritorio no la soportan igual.

## Consecuencias

Lo que se gana es un cliente de escritorio casi sin código propio. Cada deploy de la web en Vercel se ve en el escritorio la próxima vez que se abre la app, sin sacar una versión nueva ni pedirle a nadie que actualice. La sesión, el BFF, los sockets y la voz funcionan igual que en el navegador, porque la ventana es un navegador. Y la pantalla de sin conexión mejora también la web y el backoffice.

A cambio, la app de escritorio depende de que Vercel esté arriba: si el web-client se cae, el escritorio muestra la pantalla de sin conexión aunque el usuario tenga internet. Es el mismo comportamiento que tiene la web.

Electron trae su propio Chromium, así que el instalador pesa alrededor de 100 MB aunque el código propio sean unas pocas líneas. Ese Chromium también hay que actualizarlo: una versión vieja de Electron arrastra los agujeros de seguridad de esa versión de Chromium, y por eso la página corre sin Node y en sandbox.

El logo animado de `offline.html` es una copia del que arman `LogoLoader` y `globals.css` en la web, porque esa página no puede cargar nada de afuera. Si cambia el logo o la animación en `client-shared`, hay que regenerar esa página a mano. Lo mismo pasa con el backoffice, que tiene su propia copia de `LogoLoader` y de los estilos del loader.

`navigator.onLine` solo detecta que el dispositivo perdió la red, no que el backend esté caído. Si hay internet pero el gateway no responde, la web no muestra esta pantalla: cada parte muestra su propio error, como hasta ahora.

Las apps de escritorio no se firman. Windows muestra el aviso de SmartScreen la primera vez que se instala, y en macOS no se genera instalador porque haría falta una cuenta de desarrollador de Apple. El ícono actual mide 221 x 221 y el instalador de Windows pide al menos 256 x 256, así que hace falta una versión más grande antes de armar el `.exe`.
