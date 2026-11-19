# ADR-040: Login con segundo factor TOTP, PIN por dispositivo y Google, todos sobre la misma sesión

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `identify-service`, `admin`, `web-client`, `app-mobile`, `backoffice`
**Relacionadas:** ADR-005 (autenticación síncrona), ADR-011 (access y refresh token), ADR-024 (expediente de admin), ADR-041 (eventos firmados)

## Contexto

El login con email y contraseña ya emitía un access token corto y un refresh token revocable (ADR-011). Faltaban tres formas de entrar que pide el catálogo de historias:

- **Segundo factor**, para que una contraseña filtrada no alcance para entrar.
- **PIN en la app**, para volver a entrar en el celular sin escribir la contraseña completa.
- **Google**, para crear la cuenta o entrar sin contraseña propia.

El riesgo de sumar formas de entrar es que alguna esquive a las demás. Si el PIN o Google no pidieran el segundo factor, activarlo no protegería nada. Además, cada forma nueva guarda un secreto distinto, y un volcado de la base no debería alcanzar para usarlo.

## Decisión

Las tres terminan en la misma sesión, el mismo par de tokens de la ADR-011, y todas pasan por el mismo chequeo de segundo factor.

**Segundo factor con TOTP (RFC 6238).** Funciona con cualquier app autenticadora (Google Authenticator, Authy, 1Password): códigos de 6 dígitos cada 30 segundos, con un paso de tolerancia hacia cada lado por diferencias de reloj. Se activa en dos pasos: `POST /v1/me/2fa/setup` devuelve la URI `otpauth://` que el cliente muestra como QR, y el 2FA queda apagado hasta que `POST /v1/me/2fa/activate` recibe un código válido. Eso prueba que la app quedó bien configurada. Al activarlo se entregan 10 códigos de recuperación de un solo uso.

- **Cómo se guarda.** El secreto TOTP se cifra con AES-256-GCM (`TWO_FACTOR_ENCRYPTION_KEY`) antes de guardarlo, porque hay que poder leerlo para validar. Los códigos de recuperación se guardan solo como hash SHA-256, porque alcanza con compararlos. Un código TOTP ya usado no se acepta de nuevo dentro de su ventana: se guarda el último paso consumido.
- **Cómo se pide.** Cuando la cuenta tiene 2FA, el primer factor no responde con tokens. Responde 202 con un `challenge_token` válido por 5 minutos, y la sesión se emite recién en `POST /v1/login/2fa` con un código correcto. El desafío se guarda como hash, admite 5 intentos y se consume al aceptarse, así que no puede producir dos sesiones.
- **Cómo se apaga.** Desactivarlo o regenerar los códigos exige reingresar la contraseña. Por eso una cuenta creada solo con Google tiene que configurar una contraseña antes de activar el 2FA.
- **Si se pierde todo.** Quien perdió la app y los códigos pide la recuperación desde el paso del segundo factor. El staff la resuelve desde el backoffice (ADR-024), y `admin` avisa con un evento firmado (ADR-041). Si se aprueba, `identify-service` borra el 2FA de la cuenta en la misma transacción.

**PIN por dispositivo, solo como atajo.** Un usuario ya logueado configura un PIN de 6 a 8 dígitos con `POST /v1/pin`, atado a un `device_id` que la app genera una vez y guarda en el almacenamiento seguro del sistema (`expo-secure-store`). El PIN se guarda con bcrypt, igual que la contraseña. Con 5 intentos fallidos, el PIN de ese dispositivo se bloquea 15 minutos y responde 423, y hay que entrar con email y contraseña. Si la cuenta tiene 2FA, el PIN se trata como un primer factor más y también responde con un desafío. Saber el PIN no alcanza: el servidor lo busca por `device_id`, así que sin ese identificador, guardado en el dispositivo, no sirve.

**Google con OpenID Connect, validado en el backend.** El cliente obtiene un `id_token` de Google (en la web con `@react-oauth/google`, en la app con el flujo de Expo) y lo manda a `POST /v1/oauth/google`. `identify-service` verifica la firma contra las claves públicas de Google, la audiencia (`GOOGLE_CLIENT_ID`) y el vencimiento, y rechaza el token si Google no verificó el email. Si el email es nuevo, crea la cuenta. Si ya existe, la vincula, guardando el `sub` de Google en una tabla de identidades federadas. Si Google no responde, devuelve 503 para que el cliente ofrezca email y contraseña. Si la cuenta tiene 2FA, también responde con un desafío. En la app, Google solo acepta como destino una URL `https`, así que `identify-service` sirve una página de rebote que pasa el token al esquema de la app sin que llegue al servidor.

## Alternativas descartadas

- **Segundo factor por email o SMS.** El SMS cuesta plata y es vulnerable al robo de la línea. El email no es un segundo factor real si la cuenta de mail es la misma con la que se recupera la contraseña. TOTP es gratuito, funciona sin conexión y es el estándar de las apps autenticadoras.
- **WebAuthn o passkeys.** Es lo más seguro, pero su soporte en Expo y en navegadores móviles todavía es desparejo, y la historia pide un segundo factor, no reemplazar la contraseña.
- **Guardar el secreto TOTP en claro, o los códigos de recuperación cifrados.** Con el secreto en claro, un volcado de la base alcanza para generar códigos válidos. Los códigos de recuperación, en cambio, no hace falta leerlos, así que un hash es más seguro que el cifrado.
- **PIN validado solo en el celular, con la contraseña o el refresh token guardados en el dispositivo.** No necesita backend, pero guarda en el teléfono algo que sirve en cualquier lado, y no se puede limitar ni bloquear desde el servidor.
- **Biometría en lugar de PIN.** Depende del hardware y no la pide la historia. Se puede sumar después como forma de desbloquear el PIN.
- **Flujo de código de autorización de OAuth con el secreto del cliente en el backend.** Nos da acceso a la API de Google, que no usamos. Para identificar al usuario alcanza con el `id_token`, que se valida sin guardar tokens de Google.
- **Que el PIN o Google no pidan el 2FA.** Es más cómodo, pero dejaría una puerta abierta: alcanzaría con usar "Continuar con Google" para esquivar el segundo factor.

## Consecuencias

Activar el 2FA protege todas las formas de entrar, no solo la contraseña. La sesión, la revocación, el logout y la suspensión siguen funcionando igual para todas, porque todas terminan en el mismo par de tokens.

El login tiene un paso más cuando hay 2FA, y los clientes manejan dos respuestas posibles (200 con la sesión o 202 con el desafío) en los tres caminos.

Hay secretos nuevos que operar: `TWO_FACTOR_ENCRYPTION_KEY` y `GOOGLE_CLIENT_ID`. Si no se configura la clave del 2FA, el servicio usa `JWT_SECRET`, que funciona pero liga las dos claves: rotar el JWT dejaría ilegibles los secretos TOTP. En producción tienen que ser distintas. Perder esa clave obliga a todos los usuarios a volver a configurar el 2FA.

Vincular por email confía en que Google verificó ese email. Es razonable para cuentas de Google, pero si se suma otro proveedor habrá que revisarlo. La recuperación de una cuenta sin segundo factor depende de una persona del staff, así que no es instantánea.
