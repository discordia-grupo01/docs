# ADR-026: Mutation testing de los servicios en Go con gremlins

**Estado:** Aceptada  
**Fecha**: 2026-11-09  
**Servicios**: `billing`, `servers`, `identify-service`, `metrics`, `admin`  
**Relacionadas**: ADR 10 (Load testing y rate limiting de /v1/login), ADR-025 (pruebas de carga y estrés)

## 1. Contexto

La consigna propone, como opcional, mutation testing. Los servicios ya tenían cobertura alta (billing 99,1%) y el CI exige un mínimo de 70%, pero la cobertura solo dice qué líneas se ejecutan en los tests, no si los tests revisan el resultado: un test que llama a una función y no mira lo que devuelve suma cobertura y no encuentra ningún error.

La pregunta era: si alguien rompe sin querer la lógica crítica (pagos, permisos, login), ¿algún test se entera?

El mutation testing responde eso: la herramienta mete a propósito errores chicos en el código, uno por vez (cambia > por >=, niega un if, cambia || por &&, un continue por break), y corre los tests con cada uno. Si algún test falla, el error quedó detectado; si todos pasan, sobrevivió. La efectividad es detectados / (detectados + sobrevivientes).

## 2. Decisión

### 2.1 Herramienta: gremlins

- Usamos gremlins, una herramienta de mutation testing para Go. Las que nombra la consigna (mutmut, Stryker, PIT) son para Python, JavaScript y Java.
- gremlins usa la cobertura para mutar solo el código que algún test ejecuta, así que no pierde tiempo en código sin tests.

### 2.2 Alcance

- `internal/service` de los cinco servicios en Go: billing, servers, identify-service, metrics (también `internal/health`, el monitor de health checks) y admin. Es donde está la lógica de negocio.
- Quedan afuera los servicios en Elixir (messaging, notifications, voice-sfu) y los frontends.

### 2.3 Cómo se corre

- Con todos los mutantes opcionales activados (operadores lógicos, asignaciones, continue/break, operaciones de bits), para que la prueba sea más exigente.
- Limpiando antes la caché de tests de Go (`go clean -testcache`) y con un margen de tiempo amplio (`--timeout-coefficient`).
- En servers, los tests de los servicios están en `test/service/`, no al lado del código: hay que usar `--integration` (corre toda la suite con cada mutante) y `--coverpkg`. El target saca `DATABASE_HOST` y `RABBITMQ_URL` del entorno para que los tests de integración se salteen en vez de hacer DROP TABLE contra la base del .env.
- Cada repo tiene `make mutation`. No corre en el CI.

### 2.4 Qué se hace con los resultados

- Cada mutante sobreviviente se analiza uno por uno. Si es un test que falta, se agrega. Si el cambio no altera nada que se pueda comprobar (un mutante equivalente, por ejemplo uno que solo cambia cuándo se escribe un log), se documenta por qué.
- Se vuelve a correr para confirmar que los sobrevivientes corregidos ahora se detectan. Antes y después, con el análisis de cada uno, quedan en `docs/mutation-testing/` de cada repo.

## 3. Alternativas descartadas

- go-mutesting: es la otra opción conocida para Go. Elegimos gremlins porque usa la cobertura para probar solo el código que los tests ejecutan y guarda el resultado de cada mutante en JSON, lo que permitió comparar el antes y el después.
- Correrlo en el CI: en servers tarda unos 45 minutos, demasiado para cada PR. Se corre a mano antes de cambios grandes.
- Elixir (messaging, notifications, voice-sfu): muzak tiene la versión completa paga y exavier no se mantiene. No hay una opción madura.
- Frontends con Stryker: son sobre todo componentes visuales, donde los mutantes son difíciles de convertir en tests útiles.
- Exigir 100%: los mutantes equivalentes no se pueden detectar con ningún test, así que el objetivo es que todo lo que queda vivo esté explicado.

## 4. Consecuencias

### Qué se descubrió probándolo (y quedó corregido)

- billing (92,35% → 94,71%): los tests de "sigue después de un error" usaban una sola compra, así que no detectaban que una falla cortara el resto del lote. El caso más grave: al iniciar un checkout de Premium, un checkout pendiente que Mercado Pago no conoce dejaba de cancelar los siguientes, que quedaban pagables (cobro duplicado).
- servers (94,77% → 98,33%): ningún test probaba nombres ni listas de menciones justo en el máximo, ni qué se le puede cambiar a @everyone; el mute no volvía a revisar el permiso dentro de la transacción (ban y kick sí); un cambio podía borrar el banner al renombrar el servidor; cuatro operaciones podían tragarse un error del repositorio.
- identify-service (83,76% → 98,30%): ningún test medía la demora después de varios logins fallidos (la protección contra fuerza bruta del ADR 10); el límite de mails de confirmación se probaba con 10 pedidos, lejos del límite de 3; si fallaba guardar el perfil, un cambio podía borrar el avatar que el usuario ya tenía.
- metrics (service 96,77% → 100%, health 80% → 100%): los valores por defecto del monitor de health checks y qué respuesta cuenta como "sano".
- admin (96,88%): no hizo falta agregar tests; los 2 sobrevivientes solo cambian si se escribe un log.

### Positivas

- Los tests de la lógica crítica ahora revisan el resultado, no solo la ejecutan: en todos los servicios, lo que sigue vivo son mutantes equivalentes, cada uno explicado en su repo.
- Se puede repetir con `make mutation` después de cambios grandes, y comparar con los resultados guardados.

### Negativas y límites

- gremlins no mide el código que ningún test ejecuta. Quedó anotado lo que conviene cubrir: el alta de staff en admin, el proceso que levanta los mutes vencidos en servers y dos caminos de error en metrics.
- Los timeouts engañan: la primera corrida de identify dio 100% porque gremlins midió los tests en caché y 66 mutantes se pasaron de tiempo sin que les pasara nada; con la caché limpia aparecieron 57 sobrevivientes. En metrics fue al revés: 13 timeouts eran mutantes detectados. Por eso se limpia la caché y se revisa cada timeout.
- Es lento en servers (unos 45 minutos), porque cada mutante corre toda la suite.
- Los servicios en Elixir y los frontends no tienen mutation testing.
- Hallazgo aparte: el texto del vencimiento en los mails de identify diría "2h0m" si se configurara 2 horas (hoy es 1 hora y dice "1 hora").

## 5. Seguimiento

- Tests para el alta de staff (admin) y para el proceso de mutes vencidos (servers).
- Repetir `make mutation` antes de cambios grandes en pagos, permisos o login.
