# Guía: formato de error REST

Resumen práctico del [ADR-029](adr/029-formato-de-error-rest-unificado.md). Toda respuesta con status mayor o igual a 400 de un endpoint REST lleva este cuerpo:

```json
{ "error": { "code": "INVALID_BODY", "message": "El campo name es obligatorio.", "details": { "field": "name", "reason": "required" } } }
```

- `code`: string en SCREAMING_SNAKE (`^[A-Z][A-Z0-9_]*$`). Los clientes deciden por este campo.
- `message`: texto legible, no vacío, sin errores internos de librerías.
- `details`: siempre presente y siempre objeto (`{}` si no hay nada).

Schemas: [`contratos/error-response.schema.json`](contratos/error-response.schema.json) y [`contratos/error-response.openapi.yaml`](contratos/error-response.openapi.yaml). En el `openapi.yaml` de cada servicio, todas las respuestas 4xx y 5xx referencian `#/components/schemas/ErrorResponse`.

## Catálogo genérico

| Status | `code` | Cuándo |
|---|---|---|
| 400 | `INVALID_BODY` | JSON mal formado o campo inválido o faltante |
| 400 | `INVALID_QUERY` | Parámetro de query inválido |
| 400 | `INVALID_PARAMETER` | Parámetro de path inválido (sólo si el servicio responde 400) |
| 401 | `UNAUTHORIZED` | Token ausente o inválido |
| 401 | `SESSION_EXPIRED` | Token o sesión vencidos (sólo identify y admin) |
| 403 | `FORBIDDEN` | Sin permiso y sin código de dominio más preciso |
| 404 | `NOT_FOUND` | Ruta inexistente |
| 405 | `METHOD_NOT_ALLOWED` | Método no permitido |
| 406 | `NOT_ACCEPTABLE` | Accept no soportado |
| 413 | `PAYLOAD_TOO_LARGE` | Body o archivo demasiado grande |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type no soportado |
| 429 | `RATE_LIMITED` | Rate limit (Kong) |
| 500 | `INTERNAL_ERROR` | Error inesperado |
| 502 / 503 / 504 | `BAD_GATEWAY` / `SERVICE_UNAVAILABLE` / `GATEWAY_TIMEOUT` | Kong o dependencia caída |

Los errores de negocio usan un código de dominio `<RECURSO>_<SITUACIÓN>`, por ejemplo `SERVER_NOT_FOUND` o `INSUFFICIENT_POINTS`.

## Ejemplos

```json
{ "error": { "code": "SERVER_NOT_FOUND", "message": "El servidor no existe.", "details": {} } }
{ "error": { "code": "INVALID_QUERY", "message": "El parámetro limit es inválido.", "details": { "param": "limit" } } }
{ "error": { "code": "RATE_LIMITED", "message": "Demasiados intentos. Probá de nuevo más tarde.", "details": { "retry_after_seconds": 30 } } }
{ "error": { "code": "INTERNAL_ERROR", "message": "Ocurrió un error inesperado.", "details": {} } }
```

## En Go (`internal/apierr`)

```go
// Genérico
apierr.InvalidBody(c, "name", "required")
apierr.Unauthorized(c)
apierr.NotFound(c)

// De dominio: status, código, mensaje y details (nil se normaliza a {})
apierr.Abort(c, http.StatusNotFound, "SERVER_NOT_FOUND", "El servidor no existe.", nil)
```

`middleware` y `logging` importan `apierr`, nunca `handler`, para evitar ciclos. Los handlers devuelven el error de dominio y el mapeador del servicio decide status y código. En Gin, activar `HandleMethodNotAllowed` y definir `NoRoute` y `NoMethod` con el helper. Los nombres exactos de los wrappers pueden variar levemente por servicio: la fuente es el paquete de cada repo.

## En Phoenix (`<App>Web.ApiError`)

```elixir
ApiError.payload(:server_not_found)                 # %{error: %{code: "SERVER_NOT_FOUND", ...}}
ApiError.payload(:invalid_body, %{field: "name"})
ApiError.http_status(:server_not_found)             # 404
```

`describe/1` tiene un catch-all para errores desconocidos (por ejemplo de Mongo): responde 503 `<DEP>_UNAVAILABLE` o 500 `INTERNAL_ERROR`, nunca revienta. `ErrorJSON` mapea el template de status (`"404.json"`) al código del catálogo.

## Reglas

- Nunca poner `err.Error()` ni `inspect(reason)` en `message` o `details`.
- No armar el JSON de error a mano en handlers, middlewares ni plugs.
- No usar sinónimos de los códigos genéricos.
- Excepciones: `/livez` y `/readyz` (`{"status": ...}`), rutas BFF de Next y WebSocket.
