# ADR-042: Cambiar la contraseña cierra las otras sesiones al vencer su access token

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `identify-service`
**Historia:** "Cambio de contraseña" (mejora propia), CA 6: cierre de las otras sesiones
**Relacionadas:** ADR-005 (autenticación síncrona), ADR-011 (access y refresh token), ADR-040 (login con 2FA, PIN y Google)

## Contexto

Un usuario logueado puede cambiar su contraseña desde Configuración → Seguridad con `PUT /v1/me/password`. Muchas veces la cambia porque sospecha que alguien más la conoce. En ese caso no alcanza con cambiarla: si quien la conocía ya entró, sigue adentro con su sesión.

Por eso la historia pide que el cambio cierre las sesiones de los otros dispositivos y mantenga abierta la del dispositivo que hizo el cambio.

Así están armadas hoy las sesiones (ADR-011):

- Cada login crea una familia de refresh tokens con su `family_id`. Cada renovación revoca el refresh token anterior y emite uno nuevo en la misma familia. Una familia es una sesión, es decir, un dispositivo.
- El access token es un JWT de 15 minutos. Los servicios lo validan solo por firma y vencimiento, sin consultar ninguna base. Una vez firmado, nadie lo puede invalidar antes de que venza.
- El access token traía solo `sub`, `jti` y `exp`. No decía a qué sesión pertenecía, así que no había forma de saber cuál de las sesiones del usuario era la que pedía el cambio.

## Decisión

**El access token lleva la sesión.** El JWT suma un claim `sid` con el `family_id` de su sesión. Se agrega en `issueTokenPair`, que es el único lugar por donde pasan el login, el 2FA, Google, el PIN y el refresh, así que ninguna forma de entrar queda afuera. Como la renovación conserva la familia, el `sid` se mantiene igual durante toda la vida de la sesión. `RequireAuth` lo deja en el contexto de la request.

**El cambio revoca las otras familias en la misma transacción.** `ReplacePasswordHash` actualiza el hash y revoca los refresh tokens del usuario cuyo `family_id` sea distinto del `sid` de la request, todo en la misma transacción. Así no puede quedar la contraseña cambiada con las sesiones viejas vivas, ni las sesiones cerradas con la contraseña vieja.

**Los otros dispositivos se cierran al vencer su access token, como mucho en 15 minutos.** Su access token sigue siendo válido hasta que vence. Cuando el dispositivo intenta renovarlo, su refresh token está revocado, el back responde `401 SESSION_EXPIRED` y la app lo manda al login. Es el mismo camino que ya usan el logout y la suspensión, así que ni web ni mobile tienen que cambiar.

**Un token sin `sid` revoca todas las sesiones.** Los access tokens emitidos antes del deploy no traen el claim. Si alguien cambia la contraseña con uno de esos, se revocan todas las sesiones, incluida la propia, y esa persona vuelve a loguearse cuando le vence el token. Es más seguro que no revocar ninguna, y solo puede pasar en los primeros 15 minutos después del deploy, porque la primera renovación ya emite un token con `sid`.

## Alternativas descartadas

- **Cierre instantáneo con una denylist de access tokens.** Guardar en un store compartido (Redis) los `jti` o los `sid` revocados y consultarlo en cada request. Cortaría a los otros dispositivos en el momento, pero cada request autenticada de toda la plataforma pasaría a depender de ese store: si se cae o anda lento, se cae o anda lento todo. Además, la validación del JWT tendría que dejar de ser local en `servers`, `messaging`, `voice-sfu` y el resto. Es justo lo que la ADR-011 descartó a propósito, y para un cambio de contraseña, que pasa muy pocas veces, no vale la pena.
- **Cierre instantáneo con una versión de credenciales en el JWT.** Sumar al token un `pwd_version` que aumenta con cada cambio de contraseña y compararlo contra la base en cada request. Tiene el mismo problema que la denylist: vuelve a consultar la base en cada request, y obliga a cada servicio a conocer la versión vigente de cada usuario, por HTTP o con una réplica por eventos.
- **Bajar la vida del access token.** Con un token de 1 o 2 minutos la ventana se achica, pero los clientes renuevan mucho más seguido y la carga sobre `identify-service` y la tabla `refresh_tokens` se multiplica para todos los usuarios, no solo para los que cambian la contraseña.
- **Avisar a los dispositivos por el socket de `messaging` para que cierren sesión.** Sirve como aviso, pero no como medida de seguridad: un atacante con el token no tiene por qué hacer caso al aviso. Además, agrega un evento entre servicios para algo que el refresh ya resuelve.
- **Identificar la sesión actual por la cookie del refresh token.** La cookie tiene path `/v1/`, así que la app la manda sola a `PUT /v1/me/password`. Pero en la web el cambio pasa por el BFF de Next, que guarda el refresh token en su propia sesión y habría que reenviarlo a propósito solo para este endpoint. Además, el endpoint dependería de una cookie que hoy solo usan el refresh y el logout. El claim `sid` no le pide nada a los clientes.
- **Revocar todas las sesiones, también la actual.** Es más simple, pero quien cambia la contraseña tendría que volver a loguearse en el mismo momento, y la historia pide que esa sesión siga abierta.

## Consecuencias

### Positivas

- Un cambio de contraseña deja afuera a quien la conocía, en 15 minutos como mucho, sin estado compartido nuevo ni consultas en el hot path.
- No hay cambios en los clientes, en el gateway ni en los demás servicios, porque el cierre usa el mismo camino que el logout y la suspensión.
- El `sid` queda disponible para cosas futuras, como "cerrar esta sesión" o una lista de dispositivos conectados.

### Negativas y límites

- **No es instantáneo.** Hasta 15 minutos después del cambio, el otro dispositivo sigue pudiendo hacer requests con su access token. Es la misma ventana que ya aceptó la ADR-011 para el logout y la suspensión (la suspensión la achica con un chequeo extra en `RequireAuth`, que acá no se agregó).
- **El socket de `messaging` ya conectado no se corta.** Sigue abierto hasta que se reconecta y necesita un token nuevo, que ya no puede conseguir.
- **El `sid` viaja en claro dentro del JWT.** No es un secreto: identifica la familia, pero no sirve para renovar sin el refresh token, que se guarda solo como hash.
- Si en el futuro hace falta un corte instantáneo (por ejemplo, para una cuenta comprometida que reporta el staff), habría que revisar esta decisión junto con la ADR-011.
