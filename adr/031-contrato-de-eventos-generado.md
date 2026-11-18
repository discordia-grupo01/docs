# ADR-031: El contrato de eventos se genera a partir de structs de Go

**Estado:** Aceptada
**Fecha:** 2026-11-10
**Servicios:** `events-contract`, `docs` (AsyncAPI), todos los que publican o consumen eventos
**Relacionadas:** ADR-007 (pub/sub), ADR-008 (contratos de mensajería), ADR-030 (entrega de eventos)

## Contexto

El ADR-008 dejó resuelta la idea de tener un contrato explícito de cada evento, y en un primer momento lo implementamos con documentos AsyncAPI escritos a mano en el repositorio de documentación. Con el tiempo apareció el problema esperable: las copias se desfasaban. El código publicaba un campo que el documento no tenía, un evento figuraba como faltante cuando ya existía, y cada servicio mantenía su propia versión de cómo era un mismo evento.

El profesor preguntó por la generación automática del AsyncAPI, por una validación automática y por un contrato común para los eventos que usan dos o más servicios, incluido el canal interno de `messaging`.

## Decisión

La fuente de verdad pasa a ser el código: los eventos se definen como structs de Go en el repositorio `events-contract`. Una herramienta propia, `eventsgen`, genera a partir de ellas el JSON Schema de cada evento, un ejemplo válido de cada uno y el documento AsyncAPI completo. Los detalles de cada campo (formato, largo, valores permitidos, si es opcional) se escriben en una etiqueta `contract` de la propia struct. Un catálogo dice quién publica y quién consume cada evento.

Los servicios en Go importan las structs directamente, de modo que una publicación mal armada ni siquiera compila. Los servicios en Elixir usan un validador que lee los mismos JSON Schema. Los ocho servicios validan, en modo aviso, cada evento que publican y que consumen: si no cumple el contrato, lo anotan en el log y siguen, y la intención es pasar a modo estricto cuando los logs estén limpios.

El CI se encarga de que el contrato no se desvíe. Comprueba que los archivos generados coincidan con el código, y en cada pull request compara los schemas con los de la rama base y falla si el cambio rompería a algún consumidor, es decir, si quita un evento o un campo, cambia un tipo o agrega un campo obligatorio. El repositorio `docs` regenera sus schemas desde el contrato y tiene un trabajo semanal que abre un pull request si algo cambió; la explicación en prosa de cada evento se sigue escribiendo a mano. Cada servicio fija la versión del contrato en su `go.mod` o en su `mix.exs`, y la versión nueva es un tag que el CI crea solo cuando un cambio llega a `main` y pasan los tests.

Los eventos que cambian el estado de un usuario o de un servidor, como `admin.user_suspended` y `billing.premium_updated`, además van firmados con HMAC, con vectores de prueba compartidos entre Go y Elixir.

## Alternativas descartadas

- **Seguir con el AsyncAPI escrito a mano.** Es lo que teníamos y es lo que se desfasaba.
- **Partir del AsyncAPI y generar el código.** Mantendría el documento como fuente, pero obliga a generar structs de Go y módulos de Elixir desde un YAML, con herramientas más difíciles de depurar, y los detalles de un campo se escriben mejor al lado del código que lo usa.
- **Protobuf o Avro.** Dan contratos estrictos y compatibilidad verificada por la herramienta, pero cambiarían el formato de todos los mensajes de JSON a binario y exigen compilación en los dos lenguajes, y nuestros mensajes son chicos y legibles.
- **Un schema registry.** Es un servicio más para operar y desplegar, desproporcionado para ocho servicios.
- **Validación estricta desde el primer día.** Rechazaría eventos que hoy fluyen, y no sabíamos cuántos desvíos reales había; empezamos avisando.

## Consecuencias

El contrato no puede divergir del código, un cambio que rompe a un consumidor falla en el pull request y quien se suma a escuchar un evento encuentra todo en un solo lugar. La documentación de eventos de todos los dominios sale de la misma fuente.

El precio es que la fuente es Go, así que quien quiera agregar un evento desde un servicio en Elixir tiene que tocar el repositorio de contrato en Go. Los servicios en Elixir dependen del contrato como dependencia de git con un tag, y sus imágenes de Docker necesitan `git` para compilarlo. El validador de Elixir soporta solo el borrador 7 de JSON Schema. Y mientras la validación esté en modo aviso, un evento mal armado se detecta en el log pero no se frena; pasar a estricto es un paso pendiente.
