# ADR-011: Access Token de vida corta + Refresh Token de vida larga con rotación

**Estado:** Aceptado

## Contexto

El logout, la suspensión de cuentas y cualquier otro mecanismo de revocación de sesión requieren que el sistema pueda "invalidar" un token ya emitido. Un JWT verificado únicamente por firma y expiración es 100% stateless y no soporta revocación bajo ningún punto de vista: una vez firmado, es válido hasta que expira por sí solo, sin que el emisor pueda intervenir. Se evaluaron tres alternativas para resolver esta tensión: (a) persistir cada token de sesión en una tabla y consultarla en cada request autenticado (enfoque descartado en una iteración anterior de este mismo diseño, por reintroducir en cada acción del usuario el acoplamiento síncrono contra la base de datos que el uso de JWT buscaba evitar); (b) una denylist centralizada en Redis consultada por todos los servicios en cada request (revocación inmediata, pero acopla la latencia y disponibilidad de toda la plataforma a un store compartido adicional); (c) un modelo híbrido de dos tokens con vidas y responsabilidades distintas. Dado que la frecuencia de renovación de sesión es órdenes de magnitud menor que la de cualquier otra acción autenticada (una vez cada 10-15 minutos contra potencialmente decenas de requests por minuto), se optó por la alternativa (c).

## Decisión

Emitir dos tokens en el login: un access token JWT de vida corta (10-15 minutos), validado únicamente por firma y expiración, sin persistencia ni consulta a base de datos en ningún request; y un refresh token opaco de vida larga (7-30 días), persistido únicamente como su hash (nunca en texto plano), agrupado por una familia de rotación (family_id). Cada canje de refresh token por un nuevo par de tokens revoca el anterior y emite uno nuevo dentro de la misma familia (rotación). Si un refresh token ya revocado (por rotación, logout o suspensión) vuelve a presentarse, el sistema lo interpreta como evidencia de robo y revoca toda la familia de una vez, forzando un nuevo login en todos los dispositivos de esa sesión.

## Consecuencias

- **Positivas**:
    - La inmensa mayoría de los requests autenticados se validan sin tocar la base de datos, preservando la ventaja de rendimiento y escalabilidad horizontal que motivó el uso de JWT.
    - La revocación (logout, suspensión, cambio de rol) es posible sin necesidad de un estado compartido consultado en el hot path: alcanza con actuar sobre el refresh token, que se usa con muy baja frecuencia.
    - La detección de reuso convierte a un refresh token robado en una señal de alerta accionable (corta toda la sesión) en lugar de un secreto estático indefinidamente válido para quien lo obtenga.
- **Negativas**:
    - Existe una ventana de hasta la duración del access token (10-15 minutos) en la que un token ya emitido sigue siendo criptográficamente válido en toda la plataforma aun después de un logout o una suspensión, porque ningún servicio puede "apagar" un JWT ya firmado sin agregar el estado compartido que este diseño evita a propósito. Se documenta como trade-off aceptado, no como una omisión.
    - El sistema deja de ser completamente stateless: el refresh token sí requiere persistencia (una fila por sesión activa, reescrita en cada rotación), lo que introduce carga de escritura recurrente sobre la base de datos, aunque muchísimo menor a la de validar cada request.
    - Mayor complejidad de implementación frente a un único JWT de vida larga: exige lógica de rotación, manejo de familias y detección de reuso tanto en el backend como en el cliente (renovación automática y reintento de la request original ante un 401 por expiración).
    - Introduce una dependencia temporal entre servicios: si el refresh token se pierde o corrompe (por ejemplo, un error de sincronización de reloj entre instancias), el usuario debe volver a loguearse; no hay forma de recuperar la sesión sin pasar por el login.
