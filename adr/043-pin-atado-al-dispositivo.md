# ADR-043: El PIN de acceso rápido se ata al dispositivo, no a la cuenta

**Estado:** Aceptada
**Fecha:** 2026-11-19
**Servicios:** `identify-service`, `app-mobile`, `client-shared`
**Relacionadas:** ADR-005 (autenticación síncrona), ADR-011 (access y refresh token), ADR-029 (formato de error REST), ADR-040 (login con 2FA, PIN y Google)

## Contexto

La historia optativa "Registro con PIN" pide que el usuario entre a la app con un PIN numérico en vez de escribir toda la contraseña. Sus criterios piden cuatro cosas: que el PIN tenga al menos 6 dígitos, que se pueda entrar sin escribir el email, que los intentos fallidos se limiten, y que el PIN quede ligado al dispositivo, así que desde otro hay que hacer el login completo. Es solo para mobile: la historia habla de "acceso rápido desde el dispositivo móvil", y un PIN de desbloqueo no sirve de mucho en una computadora.

La ADR-040 ya puso al PIN como una de las tres formas de llegar a la misma sesión. Lo que faltaba decidir es a qué se asocia el PIN, y ahí está el riesgo: un PIN de 6 dígitos tiene un millón de combinaciones, muchas menos que una contraseña. Si valiera para la cuenta en general, activarlo dejaría la cuenta más expuesta, no más cómoda.

Hay además una restricción que viene del criterio de entrar sin escribir el email: si el usuario no manda ningún dato de su cuenta, algo tiene que decirle al backend de quién es el PIN que recibe.

## Decisión

**El PIN se asocia al dispositivo, y es el dispositivo el que identifica la cuenta.** En la tabla `device_pins`, el `device_id` es único: un dispositivo tiene un solo PIN activo, de una sola cuenta por vez. `POST /v1/pin/login` recibe el `device_id` y el PIN, busca la fila por `device_id`, y de ahí sale el usuario. Así se entra sin email, y el PIN no sirve en ningún otro lado: en otro celular, o después de reinstalar la app, no hay fila y el login se rechaza. Configurar de nuevo el PIN en el mismo aparato reemplaza la fila anterior, sea la misma cuenta u otra.

**El `device_id` lo genera la app y nunca sale del dispositivo.** Es un valor aleatorio que se crea una sola vez por instalación y se guarda en `expo-secure-store`, marcado para que iOS no lo incluya en los backups ni en el llavero de iCloud. No se usa un identificador de hardware (Android ID, IDFV, IMEI) porque el servidor no puede comprobar que sea verdadero, así que no es más confiable que uno generado por la app, y además cada plataforma lo trata distinto. Alcanza con que sea estable mientras la app esté instalada y distinto en cualquier otro aparato.

**El PIN se guarda hasheado con bcrypt, igual que la contraseña**, y se acepta solo si tiene entre 6 y 8 dígitos. El mínimo de 6 sale del criterio de aceptación. El tope de 8 lo elegimos nosotros: sin un tope, "al menos 6" permite un PIN tan largo que ya deja de ser un acceso rápido.

**A los cinco intentos fallidos, ese dispositivo queda bloqueado 15 minutos.** El contador se guarda en la base y no en memoria, así que no se pierde si el servicio se reinicia y vale igual para todas las instancias. El intento siguiente responde 423, avisando cuántos segundos faltan y que el camino alternativo es el login con email y contraseña, para que la app lo ofrezca en vez de dejar al usuario sin salida. Un PIN correcto, o un bloqueo ya vencido, vuelven el contador a cero.

**El PIN reemplaza al primer factor, no al segundo.** Si la cuenta tiene 2FA, el PIN correcto no entrega la sesión: responde 202 con el desafío, igual que el login con contraseña o con Google (ADR-040), y la sesión se emite recién al validar el código. También se revisa que el email esté verificado y que la cuenta no esté suspendida. Cuando todo da bien, la sesión se emite con la misma función que usan los otros dos logins, así que no hay una sesión especial "de PIN": el refresh, el logout y la revocación funcionan igual.

## Alternativas descartadas

- **Asociar el PIN a la cuenta y guardar el dispositivo solo como dato.** Es lo primero que sale, y es justo lo que convierte al PIN en una contraseña de seis dígitos que sirve en cualquier lado. Además habría que pedir el email para encontrar la cuenta, en contra del criterio de entrar sin escribirlo.
- **Validar el PIN en el celular, guardando ahí la contraseña o el refresh token.** No necesita backend y varias apps lo hacen así. Pero deja en el teléfono un secreto que sirve desde cualquier lado, y no se puede bloquear ni dar de baja desde el servidor: para cortar un PIN comprometido habría que desinstalar la app.
- **Usar un identificador de hardware como `device_id`.** Parece más atado al dispositivo, pero el servidor no puede verificarlo, así que no da más garantías que un valor generado por la app, y complica el código en cada plataforma.
- **Borrar el PIN al cerrar sesión.** El PIN no es parte de la sesión: es una credencial del aparato, como el PIN que desbloquea el teléfono. Si se borrara al salir, se perdería el caso de uso principal, que es volver a entrar rápido después de haber salido.
- **Bloquear la cuenta en vez del dispositivo.** Alguien probando PINs en un celular ajeno dejaría al dueño sin acceso rápido en el suyo. Bloquear el dispositivo limita el daño al aparato donde se está probando.

## Consecuencias

Lo que se gana es un login corto que no debilita la cuenta. El usuario entra con seis a ocho dígitos en vez de la contraseña, y ese PIN sirve solo en el celular donde lo configuró: no funciona en ningún otro aparato. Como el login por PIN termina en la misma sesión que el de siempre, el logout, la renovación del token y la revocación siguen funcionando sin un circuito propio.

El PIN es tan seguro como el desbloqueo del teléfono: protege de una contraseña filtrada, no de un celular en manos ajenas. Por eso el segundo factor se sigue pidiendo.

Dos cuentas no pueden tener PIN al mismo tiempo en el mismo celular: configurar el de la segunda reemplaza el de la primera. Tiene sentido para un PIN de desbloqueo, pero no para quien comparte el aparato.

Probar PINs contra la API no lleva a ningún lado: el bloqueo deja unas veinte pruebas por hora, y las combinaciones posibles son un millón. El problema aparece si se filtra la base. Cada fila de `device_pins` guarda el `device_id` y el hash del PIN juntos, que es el par que pide `POST /v1/pin/login` para entrar. Con esa tabla en la mano, el atacante prueba las combinaciones contra el hash en su propia máquina, sin pasar por la API, así que el bloqueo por intentos no lo frena. Lo único que lo demora es bcrypt, que hace lento cada intento. El daño, de todos modos, no sale del acceso rápido, porque la contraseña y el segundo factor no están en esa tabla. Ante una filtración hay que vaciarla, para que los PIN se configuren de nuevo.

Si la app mostrará la pantalla del PIN lo decide un dato guardado en el celular, porque `POST /v1/pin/login` devuelve el mismo error cuando el dispositivo no tiene PIN que cuando el PIN es incorrecto, y así no revela si un `device_id` tiene cuenta asociada. Cuando ese dato queda desactualizado, por ejemplo al restaurar un teléfono desde un backup, el usuario ve la pantalla del PIN en un dispositivo donde no hay ninguno configurado. No es un agujero, porque el backend lo rechaza igual, pero la app debería borrar ese dato ante ese error y pasar al login con email y contraseña.
