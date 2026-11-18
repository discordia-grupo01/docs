# ADR-029: Formato de error REST unificado

**Estado:** Esperando aceptación  
**Fecha:** 2026-11-18  
**Servicios:** identify, servers, admin, billing, metrics, messaging, notifications, voice-sfu (`signaling`), gateway, docs, web, mobile, backoffice  
**Relacionadas:** ADR-006 (API Gateway), ADR-005 (autenticación), ADR-011 (access y refresh token)

## 1. Contexto

El contrato de API acordado fija que los errores son `{ "error": { "code", "message", "details" } }`, pero no dice de qué tipo es cada campo ni qué códigos usar. Cada servicio lo interpretó a su manera y hoy conviven seis variantes:

| Variante | Dónde |
|---|---|
| `code` numérico | servers |
| `{"error": "texto"}` | metrics y signaling de voz |
| `{"errors": {"detail": ...}}` | framework de signaling |
| `details` ausente (por `omitempty`) | identify y billing |
| `code: "404"`, `"500"` en los errores del framework | messaging y notifications |
| `{"message": ...}` o texto plano | Kong |

Además, el mismo error tiene códigos distintos según el servicio (`INVALID_INPUT`, `INVALID_REQUEST`, `INVALID_PAYLOAD` para un body inválido).

El costo lo pagan los clientes (web, mobile y backoffice): cada uno tiene parches para leer cada variante (`reasonOf`, `String(result.code)`, `voiceErrorCodeOf`, tratamientos especiales del 403 de metrics y del 429 y 404 de Kong). Cada servicio nuevo o cada cambio de framework obliga a tocar los tres clientes, y los errores del gateway ni siquiera se pueden interpretar.

## 2. Decisión

Toda respuesta HTTP con status mayor o igual a 400 de un endpoint REST responde `Content-Type: application/json` con este cuerpo:

```json
{
  "error": {
    "code": "SERVER_NOT_FOUND",
    "message": "El servidor no existe.",
    "details": {}
  }
}
```

### 2.1 Sobre

| Campo | Tipo | Regla |
|---|---|---|
| `error` | objeto | Obligatorio. Única clave de primer nivel. |
| `error.code` | string | Obligatorio. Cumple `^[A-Z][A-Z0-9_]*$`. Nunca numérico ni en minúscula. Es estable: los clientes deciden por este campo. |
| `error.message` | string | Obligatorio y no vacío. Texto legible; los mensajes nuevos van en español. Nunca incluye el error de una librería, stack traces, SQL, nombres de structs ni datos personales de terceros. |
| `error.details` | objeto | Obligatorio, siempre presente y siempre objeto. Si no hay nada que agregar, `{}`. Nunca `null`, array ni string. |

El schema se publica en [`contratos/error-response.schema.json`](../contratos/error-response.schema.json) (JSON Schema) y [`contratos/error-response.openapi.yaml`](../contratos/error-response.openapi.yaml) (componente `ErrorResponse`). Cada `openapi.yaml` declara el schema con los tres campos en `required` y lo referencia en todas sus respuestas 4xx y 5xx.

### 2.2 Un único helper por servicio

Cada servicio arma el sobre en un solo lugar: el paquete `internal/apierr` en Go y el módulo `ApiError` en Phoenix. El helper normaliza `details` nulo a `{}`. Ningún handler, middleware ni plug arma el JSON de error a mano. Los handlers devuelven el error de dominio y un mapeador central decide status y código.

### 2.3 Catálogo genérico

Estos códigos son obligatorios para su caso; ningún servicio usa un sinónimo.

| Status | `code` | Cuándo | `details` |
|---|---|---|---|
| 400 | `INVALID_BODY` | JSON mal formado, binding fallido, campo inválido o faltante | `{"field", "reason"}` si se conoce el campo; `{}` si el JSON está mal formado |
| 400 | `INVALID_QUERY` | Parámetro de query inválido | `{"param"}` |
| 400 | `INVALID_PARAMETER` | Parámetro de path inválido, sólo en los servicios que hoy responden 400 en ese caso | `{"param"}` |
| 401 | `UNAUTHORIZED` | Falta el token, es inválido o la firma no verifica | `{}` |
| 401 | `SESSION_EXPIRED` | Sólo cuando el servicio distingue que el token o la sesión venció (identify, admin) | `{}` |
| 403 | `FORBIDDEN` | Sin permiso, si no hay un código de dominio más preciso | `{}` o `{"permission"}` |
| 404 | `NOT_FOUND` | Ruta inexistente | `{}` |
| 405 | `METHOD_NOT_ALLOWED` | Método no permitido sobre una ruta existente | `{}` |
| 406 | `NOT_ACCEPTABLE` | Accept no soportado | `{}` |
| 413 | `PAYLOAD_TOO_LARGE` | Body o archivo demasiado grande | `{"max_bytes"}` si se conoce |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type no soportado | `{}` |
| 429 | `RATE_LIMITED` | Rate limit genérico (Kong) | `{"retry_after_seconds"}` si se conoce |
| 500 | `INTERNAL_ERROR` | Error inesperado, panic o excepción | `{}` (nunca el error interno) |
| 502 | `BAD_GATEWAY` | Kong: el upstream respondió mal | `{}` |
| 503 | `SERVICE_UNAVAILABLE` | Dependencia caída, sin un `<DEP>_UNAVAILABLE` más preciso | `{}` |
| 504 | `GATEWAY_TIMEOUT` | Kong: timeout del upstream | `{}` |

`SESSION_EXPIRED` y `UNAUTHORIZED` se tratan igual en los clientes (refrescar o volver a loguear).

### 2.4 Códigos de dominio

Los errores de negocio usan un código propio `<RECURSO>_<SITUACIÓN>`: `SERVER_NOT_FOUND`, `USER_ALREADY_SUSPENDED`, `INSUFFICIENT_POINTS`, `LOGIN_ATTEMPTS_EXCEEDED`, `VOICE_FORBIDDEN`. Los que ya existen en texto se mantienen tal cual porque los clientes los consumen; los que sólo existían en minúscula pasan a mayúscula conservando el nombre (`voice_forbidden` a `VOICE_FORBIDDEN`, `name_taken` a `NAME_TAKEN`). Un mismo concepto dentro de un servicio usa un solo código.

### 2.5 Transición de servers

`error.code` pasa de número a texto (código de dominio a partir del `reason` actual, o uno genérico). Se mantienen `details.reason` y `details.field` con sus valores actuales porque los tres clientes los leen; se eliminarán en otro trabajo. `details.error_code` (`ACCOUNT_SUSPENDED`, `SERVER_SUSPENDED`) pasa a ser `error.code` y se mantiene también en `details.error_code` durante la transición.

### 2.6 Errores del framework

Cada servicio responde con el sobre ante ruta inexistente (404 `NOT_FOUND`), método no permitido (405 `METHOD_NOT_ALLOWED`; en Gin, `HandleMethodNotAllowed = true` y `NoMethod`), JSON mal formado (400 `INVALID_BODY`) y panic o excepción (500 `INTERNAL_ERROR`, con la recovery propia en Go y `ErrorJSON` en Phoenix). En Phoenix, `ErrorJSON` mapea el template de status (`"404.json"`) al código textual del catálogo, no a `String.upcase(template)`.

### 2.7 Errores de Kong

Las respuestas de error originadas en Kong, no en un upstream, se reescriben al sobre:

| Situación | Status | `code` |
|---|---|---|
| Plugin `jwt` | 401 | `UNAUTHORIZED` |
| Plugin `rate-limiting` | 429 | `RATE_LIMITED`, conservando `Retry-After` y `X-RateLimit-*` |
| Sin ruta | 404 | `NOT_FOUND` |
| Upstream | 502 / 503 / 504 | `BAD_GATEWAY` / `SERVICE_UNAVAILABLE` / `GATEWAY_TIMEOUT` |

Se hace con un plugin global `post-function` en la config declarativa que actúa sólo cuando `kong.response.get_source()` no es `"service"`, más `error_default_type = application/json` para que los errores del core nunca salgan en texto plano. Las respuestas de error que vienen del upstream no se tocan, aunque sean grandes o en streaming.

### 2.8 Excepciones

- **`/livez` y `/readyz`**: son endpoints de operación para el orquestador y mantienen `{"status": ...}`.
- **Rutas BFF de Next** (`src/app/api/**/route.ts` de web y backoffice): contrato interno navegador-BFF con formato propio (`{ok, message, code?}`). Sí se adapta cómo leen los errores de la API.
- **WebSocket y Phoenix Channels**: no son REST. Messaging y notifications ya usan el mismo sobre ahí; signaling queda como está.
- Un preflight CORS fallido no tiene body, y HEAD no lleva body por definición.
- Fuera de alcance: los eventos (`events-contract`) y la API de LiveKit.

### 2.9 Casos borde

- Si ya se escribieron los headers antes de un panic, no se puede reescribir: se loguea y se aborta.
- `details` sólo acepta mapas serializables; nunca structs de error.
- Con varios errores de validación se reporta el primero en `details.field`; si un servicio ya devuelve varios usa `details.fields: [{field, reason}]`.
- Un error desconocido de una dependencia cae en un catch-all (`<DEP>_UNAVAILABLE` o `INTERNAL_ERROR`); nunca debe crashear el mapeador.
- Si el cliente cortó la conexión (`context.Canceled` en Go) no se deja un 200 implícito.
- Los errores de endpoints multipart usan el mismo sobre JSON.

## 3. Alternativas descartadas

- **RFC 9457 (`application/problem+json`)**: es el estándar, pero obliga a cambiar el sobre en todos los servicios y clientes, y el sobre `{error: {...}}` ya está acordado en el contrato de API y casi todos los servicios lo usan. El beneficio (interoperabilidad con terceros) no aplica: la API la consumen sólo nuestros tres clientes. Los campos `code`, `message` y `details` equivalen a `type`, `title` y extensiones, así que migrar más adelante es mecánico.
- **`code` numérico**: es lo que usaba servers. Obliga a mantener una tabla de números que nadie recuerda, se confunde con el status HTTP, y ya había que traducirlo a texto (`reason`) para que los clientes decidieran. Un código textual se lee en logs y en tests sin tabla.
- **Mantener un formato por servicio**: cuesta cero ahora, pero cada cliente seguiría cargando un parche por variante y los errores del gateway quedarían sin interpretar. Es el estado que causó el problema.

## 4. Consecuencias

**Positivas**

- Los clientes leen un solo formato y deciden por `error.code`; desaparecen los parches por servicio.
- El helper único centraliza el formato: un cambio futuro toca un archivo por servicio.
- Los errores de Kong también son interpretables.
- Un schema único permite validar contratos y tests con la misma regla.

**Negativas y costos**

- Renombres visibles para los clientes:

| Variante actual | Pasa a |
|---|---|
| `INVALID_INPUT` (identify) | `INVALID_BODY` |
| `INVALID_REQUEST` (billing) | `INVALID_BODY` o `INVALID_QUERY` según el caso |
| `INVALID_PAYLOAD` (messaging, notifications) | `INVALID_BODY` |
| `INTERNAL_SERVER_ERROR` (identify) | `INTERNAL_ERROR` |
| `"404"`, `"500"`, etc. (messaging y notifications) | código textual del catálogo |
| `error.code` numérico (servers) | texto |
| `{"error": "texto"}` (metrics, signaling) | sobre completo |
| 401 `SESSION_EXPIRED` en admin sin distinguir vencimiento | `UNAUTHORIZED` |

- Migración de los clientes (web, mobile, backoffice y `client-shared`) en una segunda fase, que depende de los cambios visibles de cada servicio. Mientras dure la transición de servers se mantiene la lectura de `details.reason`.
- `details.reason`, `details.field` y `details.error_code` de servers quedan duplicando información hasta que los tres clientes lean sólo `error.code`.
- Tests de regresión obligatorios por servicio: el helper (`details` nulo a `{}`, `code` válido), ruta inexistente, método no permitido (Go), JSON mal formado, panic o excepción con body y 401 del middleware. Todos verifican la forma completa. En el gateway, un smoke test en CI que valide el sobre de 401, 404 y 429.

Guía para quienes implementan: [formato-de-errores.md](../formato-de-errores.md).
