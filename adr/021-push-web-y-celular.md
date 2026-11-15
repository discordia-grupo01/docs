# ADR-021: notifications: push a web y celular, armado a partir de eventos y solo con la app cerrada

**Estado:** Aceptada e implementada. Verificada de punta a punta en la web y en un celular Android. iOS nativo sin verificar (sección 4)  
**Fecha**: 2026-11-03 (actualizada el 2026-11-04 con lo implementado, secciones 2.9 a 2.11)  
**Servicios**: `notifications` (envío), `messaging` (eventos nuevos y enriquecidos), `events-contract`, `docs` (AsyncAPI), `gateway` (Kong), `infrastructure` (variables de entorno), `client-shared`, `web-client` (service worker y pantalla de ajustes), `app-mobile` (registro del dispositivo y pantalla de ajustes)  
**Decidida por**: Facundo Madotta (diseño, implementación y pruebas)  
**Historia**: "Notificaciones push": CA1 push por mención o mensaje directo con la app cerrada, CA2 desactivar las notificaciones push desde la configuración  
**Relacionadas**: ADR-020 (no leídos por eventos; deja el push fuera de alcance), ADR-018 (outbox), ADR-017 (réplica local)

## 1. Contexto

La historia pide que un usuario se entere de una mención o de un mensaje directo **aunque no tenga la aplicación abierta**, en su dispositivo (navegador o celular), respetando sus preferencias de silenciado, y que pueda desactivar los push sin que cambien los indicadores dentro de la app.

Partimos de lo que ya está resuelto:

- Las preferencias (silenciar canal o servidor, nivel todas / menciones / ninguna) viven en `notifications` (historias #64 y #65).
- Los eventos de mención y de mensaje directo ya llegan a `notifications` (ADR-020 y la historia #67).
- `notifications` no hace pedidos HTTP a otros servicios (ADR-020).

Y de lo que el ADR-020 dejó afuera: las notificaciones push al celular, y el **contenido** del mensaje en los eventos ("innecesario para la historia y expone datos de más al bus").

El resultado buscado es el de WhatsApp o Discord: un aviso con "Servidor - Canal" y "Nombre: mensaje" (o "Mensaje directo" y "Nombre: mensaje"), **sin** que `notifications` llame a otros servicios para armarlo.

## 2. Decisión

### 2.1 Quién recibe un push

Se evalúa con la misma lógica de preferencias que el historial, tomando el estado al procesar el evento:

- **Mensaje directo**: Siempre. Si hay un bloqueo entre los dos, `messaging` rechaza el envío y no hay mensaje ni evento (2.7).
- **Mención**: Si el nivel efectivo del canal no es "ninguna". Silenciar siempre gana.
- **Mensaje común de un canal**: Solo si el nivel efectivo es "todas". El nivel por defecto es "menciones", así que "todas" es opt-in.

El autor nunca recibe push de su propio mensaje. Para los mensajes comunes, los candidatos son solo los usuarios con nivel "todas" explícito en ese canal o servidor (una consulta a sus preferencias); de ellos se verifica que puedan ver el canal con la réplica de permisos. Así el reparto nunca recorre a todos los miembros.

### 2.2 El push se arma con datos que ya viajan en eventos

No hay llamadas HTTP entre servicios (ADR-020). Lo que el aviso necesita sale de dos lugares:

- **Del evento de mensaje.** `messaging.message_created` y `messaging.direct_message_created` ganan dos campos opcionales: `content_preview` (el texto, cortado a unos 140 caracteres) y `channel_name`. `messaging` ya tiene ambos. El texto sale normalizado: un mensaje sin texto pero con adjuntos dice "Archivo adjunto". Las menciones se resuelven así (ajuste hecho al implementar, porque `@usuario` no decía a quién se mencionaba):
- las de **rol** se reemplazan en `messaging` por `@rol`;
- las de **usuario** viajan como `<@id>` y las resuelve `notifications` con su réplica de nombres, en una sola consulta por aviso (`@Ana`); si el nombre no se conoce queda `@usuario`;
- para el corte de unos 140 caracteres, cada mención de usuario cuenta como 8 (`@usuario`) y el corte nunca parte una mención por la mitad.

Esto obliga a desplegar `notifications` antes que `messaging`; de lo contrario se vería `<@id>` crudo hasta que ambos estén actualizados.

- **De réplicas locales en `notifications`**, alimentadas por eventos que **ya existen**:
    - el nombre de quien escribe sale de `users.profile_updated` (snapshot completo con `version`: se aplica solo si la versión es mayor, como hace `messaging`);
    - el nombre del servidor sale de `servers.server_updated` (gana el `occurred_at` más nuevo).

El texto del mensaje **no se guarda** en `notifications`: se usa para armar el push y se descarta. Si falta algún nombre se usa uno genérico ("Usuario", "Servidor"), no se pide a nadie.

Formato del aviso:

```
Servidor - Canal                 Mensaje directo
```

```
Nombre: mensaje                  Nombre: mensaje
```

El push lleva además los ids (`server_id`, `channel_id` o `conversation_id`, `message_id`) para que, al tocarlo, el cliente abra el lugar correcto.

### 2.3 Solo si la app está cerrada: presencia por eventos

El CA1 pide push cuando el usuario **no** tiene la app abierta. `messaging` ya sabe qué conexiones tiene cada usuario (módulo de presencia, con estados activa e inactiva a los 5 minutos sin interacción).

`messaging` publica por el outbox un evento de presencia cada vez que cambia lo que importa para el push (nombre provisorio `messaging.user_presence_changed`), con el estado **real** de conexiones (activa, inactiva o ninguna) y si el usuario eligió "No molestar". Un usuario "invisible" con la app abierta cuenta como abierta: la visibilidad es para los demás, no para sus propios avisos. `notifications` mantiene una réplica de ese estado, con la misma regla de versiones que la de perfiles.

Se **suprime** el push si, en **cualquier dispositivo** del usuario:

- tiene una conexión **activa** (esa sesión ya recibe todo en vivo), o
- eligió **"No molestar"**.

Con la app abierta pero **inactiva** (por ejemplo, una pestaña olvidada) o sin conexión, **sí hay push**.

**Si la información falta o está vencida, se asume "cerrada" y se envía** (falla abierta): preferimos un aviso de más a perder uno. La réplica tiene un vencimiento como red de seguridad.

Segunda capa, del lado del cliente: si la app está en primer plano, no muestra el aviso.

Esto reemplaza a la alternativa de "demorar el envío y cancelarlo si el usuario lee" (sección 3): si la app está cerrada en el momento del envío, no hay forma de que lo haya leído en ese dispositivo, y si lo lee en otro, esa sesión está activa y no hubo push.

### 2.4 Dispositivos

Cada navegador o celular se registra por separado, con su proveedor:

- **Web Push (VAPID)**: Para: Navegadores; Qué se guarda: la suscripción (endpoint y claves)
- **Expo Push Service**: Para: App móvil (Android primero); Qué se guarda: el token de Expo

Colección `push_devices`: id opaco generado por el servidor, `user_id`, `provider`, `platform`, la credencial, `created_at`, `last_used_at` y `last_error`.

Rutas (todas autenticadas, detrás de Kong):

```
POST   /v1/notifications/push/devices      cuerpo con la credencial -> 201 {id}
```

```
DELETE /v1/notifications/push/devices/:id  el id opaco, nunca el token
```

```
PUT    /v1/notifications/push/settings     {enabled}
```

```
GET    /v1/notifications/push/settings
```

**El token no viaja jamás en un path ni en una query**, y tampoco aparece en los logs. Registrar dos veces la misma credencial es idempotente y devuelve el mismo id. Para Web Push solo se aceptan endpoints `https` de servicios de push conocidos (protección contra que nos hagan llamar a una URL arbitraria). Hay un tope de dispositivos por usuario (valor a definir, por ejemplo 10).

Si el sistema operativo bloquea los avisos de un dispositivo, el servidor no se entera: el proveedor lo informa como token inválido y el dispositivo se borra (2.6).

### 2.5 Interruptor de push

Un **único interruptor por usuario** (`push_enabled`, por defecto activo) vale para todos sus dispositivos, sea cual sea el que se use para cambiarlo. Es un estado separado de los indicadores: apagarlo no toca el historial, los contadores ni las menciones sin leer. La alternativa por dispositivo se consideró y quedó como pregunta (sección 6).

### 2.6 Envío

- **Asíncrono y acotado.** El consumidor de eventos no espera al proveedor: entrega el trabajo a un grupo de procesos con concurrencia limitada.
- **Sin duplicados.** RabbitMQ reentrega eventos (*at-least-once*); se descarta un envío repetido por (evento, dispositivo).
- **Errores del proveedor.** Un token inválido (`404` o `410` en Web Push, `DeviceNotRegistered` en Expo) borra el dispositivo. Un `429` o un `5xx` se reintenta con espera acotada. Un fallo de envío **no** devuelve el evento a la cola, para no repetir el aviso en los otros dispositivos.
- **Expo** acepta lotes: se agrupan los avisos del mismo evento.
- **Sin agrupar ni limitar.** Cada mensaje que corresponde genera su propio push. Se confía en que no hay spam (pregunta en la sección 6).

Configuración por entorno: claves VAPID (`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; la pública la entrega el servicio en `GET /v1/notifications/push/vapid-public-key`) y, opcionalmente, un token de acceso de Expo (`EXPO_ACCESS_TOKEN`). Firebase **no** toca este servicio: la credencial de Google (la cuenta de servicio) se sube a Expo, que es quien habla con FCM (sección 2.9).

### 2.7 Bloqueos

No hace falta ningún cambio. Al enviar un mensaje directo, `messaging` verifica el contacto (`Blocks.check_contact`) y **rechaza el envío** si hay un bloqueo en cualquiera de los dos sentidos (`user_blocked` si el autor bloqueó al destinatario, `dm_not_delivered` si el destinatario bloqueó al autor). Como el evento sale en la misma transacción que el mensaje, un DM rechazado no genera mensaje, evento, push ni entrada en el historial.

Los bloqueos de `messaging` solo alcanzan a los mensajes directos. Una mención de un usuario bloqueado en un canal de servidor sigue generando push según las preferencias del canal.

### 2.8 Una sola instancia

Se mantiene lo del ADR-020: `notifications` corre una instancia. Eso evita avisos duplicados entre instancias. Si algún día se escalara, habría que repartir el trabajo de envío con un reclamo atómico por evento.

### 2.9 Proveedores: Web Push, Expo y dónde entra FCM

Se usan **dos caminos de entrega**, según el cliente. En ningún caso el backend usa el SDK de Firebase ni llama a FCM directamente.

- **Web**: Mecanismo: Web Push estándar (Push API, service worker y claves VAPID, RFC 8291 y 8292); Qué hace `notifications`: Envía el aviso cifrado al *endpoint* de la suscripción del navegador; Dónde interviene FCM: Chrome entrega esos avisos a través de FCM. Por eso `fcm.googleapis.com` está entre los hosts permitidos (`PUSH_ALLOWED_HOSTS`), junto con los de Mozilla, Apple y Windows
- **App Android**: Mecanismo: `expo-notifications` y el **Expo Push Service**; Qué hace `notifications`: Envía el aviso a Expo con el token de Expo del dispositivo; Expo lo reenvía; Dónde interviene FCM: Expo entrega a Android a través de FCM. Para eso el proyecto de Firebase aporta `google-services.json` (configuración pública, va en el repo de la app) y la clave de la cuenta de servicio (FCM V1, **secreta**, subida a EAS con `eas credentials`, nunca al repo)

Por qué este diseño y no FCM directo (`@react-native-firebase/messaging` y el SDK de Google en el backend):

- **Menos credenciales y un solo formato.** La app registra un único token de Expo y el backend lo usa; no hay que manejar tokens de FCM y de APNs por separado ni dos protocolos.
- **La app ya es Expo.** `expo-notifications` está integrado con EAS y con el build de la app; el camino directo exigiría módulos nativos propios.
- **El patrón es el mismo.** El backend publica el aviso y un servicio externo lo entrega al dispositivo, que es lo que ofrece FCM.

Costo asumido: **Expo queda como intermediario** (una dependencia más, con sus límites y su disponibilidad). Para acotarlo, el proveedor está detrás de un contrato (*behaviour*) en `notifications`, de modo que cambiarlo no toca la lógica de quién recibe qué.

### 2.10 Clientes

Lo que se construyó en cada cliente, sobre la API de la sección 2.4:

**Web (`web-client`).**

- Un **service worker** (`public/sw.js`) muestra **todos** los push que llegan. El aviso usa como `tag` el canal o la conversación y `renotify`, para que varios mensajes de la misma conversación se reemplacen en vez de apilarse, y un ícono propio.
- Al tocar el aviso se abre la conversación correcta: `/home?server=<id>&channel=<id>` para un canal y `/home?dm=<id del autor>` para un mensaje directo. La regla que decide el destino a partir de los datos del push vive en `client-shared` (`pushNotificationTarget`), para que web y móvil usen la misma.
- La suscripción se registra con `POST /v1/notifications/push/devices`. El permiso del navegador es **por origen**, así que el navegador y la web instalada como app comparten un único dispositivo. Los dispositivos se sincronizan con la sesión y se borran al cerrar sesión.
- Las rutas pasan por el BFF de la web (`/api/notifications/push/...`), que reenvía a Kong con el JWT del usuario.

**App móvil (`app-mobile`, Android).**

- `expo-notifications` obtiene el token de Expo con el `projectId` de EAS, previo permiso del usuario, y la app lo registra con el mismo endpoint (con su `id` y el tope de 10 dispositivos por usuario, `409` al superarlo).
- La app crea un canal de Android `default` con importancia alta. No muestra el aviso, no reproduce sonido ni marca la insignia si está en primer plano (segunda capa de la sección 2.3).
- Al tocar la notificación, también con la app cerrada, se abre el canal o el chat directo que corresponde, una vez cargados el último lugar y los servidores.
- Pantalla de ajustes con el mismo diseño que la web: el interruptor de la cuenta, el estado de este dispositivo (activar, desactivar, bloqueado con acceso a los ajustes del sistema, no soportado), y quita el dispositivo al cerrar sesión.

**Ambos.** Los canales de voz no tienen opciones de notificación (no hay nada que silenciar en ellos): la regla `channelHasNotifications` está en `client-shared`.

### 2.11 Puesta en producción

El orden y los pasos manuales importan, porque las réplicas de `notifications` nacen vacías (ADR-017):

1. **Despliegue:** `notifications` antes que `messaging` (2.2). Variables en el entorno de `notifications`: `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT`; sin la clave privada no sale ningún push web.
1. **Backfills** de los datos que ya existían, en cada base de origen. Todos solo insertan filas en el outbox y se pueden repetir sin riesgo, porque los consumidores se quedan con el dato más nuevo:
    - identify: re-publicar `users.profile_updated` de todos los usuarios (nombres de quien escribe y de los mencionados);
    - servers: re-publicar `servers.server_updated` (nombres de servidores), `servers.channel_created` (canales) y los eventos de acceso (dueños, roles, miembros y *overrides*, migración `0022`).
    - Sin el backfill de canales y miembros, silenciar un canal o un servidor devuelve `404` en `notifications`, porque no los conoce. Se verificó en producción: con las réplicas completas el problema desaparece.
1. **Android:** subir la clave de la cuenta de servicio de Firebase a EAS (`eas credentials`) y generar el build con el perfil `preview`. Expo Go no soporta push remotos.

Latencia medida: el aviso tardaba unos 3,2 s desde que se escribía el mensaje. La causa estaba en el outbox de `messaging` (un evento por mensaje y por consulta, más una espera fija de 1 s entre consultas). El poller ahora vuelve a consultar de inmediato mientras publica algo, y la demora quedó en torno a 0,2 s (medición local).

## 3. Alternativas descartadas

- **Pedir por HTTP el texto y los nombres a `messaging`, `identify-service` y `servers`**: Va contra el ADR-020, acopla disponibilidad y suma latencia a cada aviso.
- **Push solo con ids; que el cliente arme el aviso**: Privado, pero poco confiable en celulares: iOS casi no permite trabajo en segundo plano, y Android lo limita.
- **Demorar el envío unos segundos y cancelarlo si el usuario lee**: Exigía eventos de "leído" nuevos. La presencia lo resuelve sin demoras (2.3).
- **Que el servidor mande siempre y el cliente decida**: No cumple la letra del CA1 ("sin la aplicación abierta") y gasta envíos de más. Queda solo como segunda capa.
- **Saber si la app está abierta por el socket de `notifications`**: El front todavía no se conecta a él y `messaging` ya tiene la presencia.
- **Enviar directo a FCM y APNs, sin Expo**: Más integración (credenciales de Apple, dos protocolos, módulos nativos propios) sin ganancia: la app ya es Expo (sección 2.9).
- **Web Push también para el celular, con la web instalada como app**: La app nativa ya existe y recibe avisos con la web cerrada de forma más confiable; el navegador del teléfono limita el trabajo en segundo plano.
- **Un proveedor de terceros (OneSignal u otro)**: Dependencia de un servicio más sin necesitarlo.
- **Interruptor por dispositivo**: Más estado y una pantalla más. Queda como pregunta.
- **Agrupar avisos por conversación y limitar por minuto**: Decidimos mostrar todas las notificaciones. Queda como pregunta.

## 4. Consecuencias y límites

- **Excepción al ADR-020: el contenido viaja en dos eventos.** El texto (cortado) va en `message_created` y `direct_message_created`, no solo ids. Se acota así: son dos eventos, el texto sale de `notifications` descartado después de armar el aviso, y no se persiste. Los demás eventos siguen llevando solo ids.
- **Privacidad.** Web Push va cifrado hasta el navegador. En Android e iOS el texto pasa por Google, Apple y Expo, como en WhatsApp o Discord.
- **La presencia puede quedar desactualizada.** Si se perdiera una transición, el usuario podría figurar activo y no recibir push. El outbox (*at-least-once*), el vencimiento de la réplica y la regla de fallar abierto lo acotan. El error contrario (un push con la app en primer plano) lo cubre el cliente.
- **Arranque sobre datos existentes.** Las réplicas de nombres, de presencia, de canales y de accesos nacen vacías. Hace falta re-publicar perfiles, servidores, canales y accesos (2.11); mientras tanto el aviso usa nombres genéricos, se asume "cerrada" y silenciar un canal devuelve `404`. Es un paso manual de la puesta en producción, no automático.
- **Dependencia de Expo.** Si el Expo Push Service no está disponible o cambia sus condiciones, el celular deja de recibir avisos; la web no se ve afectada (usa Web Push). Mitigación: el proveedor está detrás de un contrato (2.9).
- **Compatibilidad de eventos.** Los campos nuevos son opcionales y los consumidores ignoran lo que no conocen. Orden de despliegue: `notifications` primero (crea las colas y réplicas nuevas), después `messaging`.
- **iOS nativo no se puede verificar:** requiere una cuenta de Apple Developer (paga) que el equipo no tiene. Queda documentado. La alternativa de web push en un iPhone (instalando la web en la pantalla de inicio) no se evaluó.
- **No se retiran avisos ya mostrados** en otros dispositivos cuando el usuario lee.
- **Edición y borrado.** `messaging` publica `messaging.message_updated` (solo mensajes de canal, con las menciones posteriores a la edición) y `messaging.message_deleted`. `notifications` compara con las entradas que ya tiene: agrega y avisa (con "(editado)") a quien quedó mencionado, quita la entrada de quien dejó de estarlo, y borra las entradas de un mensaje borrado. Un push ya enviado no se puede corregir ni retirar. `message_updated` lleva texto, así que se trata como `message_created` (no se audita).
- **Sin anti-spam.** En un canal en "todas" cada mensaje es un aviso.
- **Fuera de alcance:** horarios de no molestar, silencios con vencimiento, y push nativo en iOS.

**Verificación realizada** (2026-11-03 y 2026-11-04):

- **Local, de punta a punta:** un mensaje directo y uno de canal de un usuario a otro llegan como push; con nivel "todas" llegan también los mensajes comunes y con "menciones" no; el título es `Servidor - canal` y el texto `Nombre: mensaje`, con las menciones resueltas (`@Ana`).
- **Web:** el service worker muestra el aviso y, al tocarlo, abre el chat directo o el canal correcto.
- **Producción, Android:** el celular recibe los avisos con la app registrada (probado por el equipo). Silenciar canales y servidores funciona una vez completados los backfills (2.11).
- **No verificado:** el push web en el entorno de producción (se probó en local); iOS nativo (sin cuenta de Apple Developer); el comportamiento con cuotas o caídas del Expo Push Service.
