# ADR-008: Contratos de Mensajería

**Estado:** Aceptado
**Servicios:** `events-contract`, `docs` (AsyncAPI), todos los que publican o consumen eventos
**Relacionadas:** ADR-007 (pub/sub), ADR-030 (entrega de eventos), ADR-031 (cómo se genera el contrato)

## Contexto

RabbitMQ transporta bytes y no mira el contenido de los mensajes. Sin un contrato explícito, cada servicio interpreta el payload según una convención que nadie dejó escrita, y eso termina en expectativas distintas sobre el mismo evento, en tener que leer el código de otro equipo para entender un campo y en fallas que nadie esperaba. La cátedra además hizo varias preguntas concretas: quién define la forma de un mensaje, qué pasa si se agrega o se saca un campo, cuándo nos damos cuenta de que un evento está mal armado, cómo se suma un servicio nuevo, qué herramienta existe para documentar APIs asíncronas, y si un evento representa un hecho o una orden.

## Decisión

Cada evento tiene un contrato versionado que vive en un solo lugar, el repositorio `events-contract`. Es la fuente de verdad: los eventos se definen como structs de Go, y de ahí se generan el JSON Schema de cada evento, un ejemplo válido y un documento AsyncAPI completo, que describe el exchange, las routing keys, el payload y quién publica y quién consume cada evento. Cómo funciona esa generación se explica en el ADR-031. El repositorio `docs` conserva la explicación en prosa de cada evento, y el CI comprueba que coincida con el contrato.

Los servicios en Go importan las structs directamente y los de Elixir usan un validador que lee los mismos JSON Schema. Cada servicio fija la versión del contrato que usa, y el repositorio publica una versión nueva con cada cambio que llega a `main`.

Quien define la forma de un evento es el servicio que lo publica, porque es el dueño del hecho. Pero nadie la define en su código por su cuenta: el evento se declara primero en `events-contract`, junto con el catálogo de quién lo publica y quién lo consume.

Agregar un campo nuevo es compatible: tiene que ser opcional, y los consumidores que no lo conocen lo ignoran. Quitar un campo, cambiar su tipo o agregar uno obligatorio es un cambio incompatible. Eso no lo dejamos librado a la revisión humana: en cada pull request, la herramienta `eventsgen compat` compara los schemas contra los de la rama base y falla si el cambio rompería a algún consumidor.

Para saber si un evento llega mal, los servicios validan contra el contrato tanto lo que publican como lo que consumen. Por ahora, cuando un evento no cumple, lo anotan en el log y siguen, sin rechazarlo, para poder encontrar los desvíos reales antes de volver la validación estricta. Si un evento llega roto, igualmente no bloquea a los demás: tras cinco intentos se aparta a la cola de eventos muertos (ADR-030).

Un servicio nuevo que quiera escuchar un evento encuentra todo en `events-contract` y en el AsyncAPI, que describe exchange, routing key y payload sin necesidad de leer el código de otro equipo. Los eventos que cambian el estado de un usuario o de un servidor, como `admin.user_suspended` y `billing.premium_updated`, además van firmados con HMAC, para que otro servicio no pueda falsificarlos.

Un evento representa siempre un hecho consumado, de ahí que los nombres estén en pasado. El consumidor no está obligado a hacer nada y el publicador no espera respuesta.

## Alternativas descartadas

- **JSON Schema escritos a mano en el repositorio de documentación.** Fue nuestra primera idea, pero tarde o temprano el schema y el código divergen, y un documento que se desactualiza deja de servir como fuente de verdad. Generar el schema desde el código elimina esa posibilidad.
- **Un schema registry centralizado, como el de Confluent.** Rechazaría el mensaje incluso si el publicador se olvidó de validar, pero es un componente más que operar, y no se justifica para este volumen.
- **Que el publicador valide y rechace el evento mal armado.** Falla rápido y cerca del origen, pero un error de validación nuevo en un publicador puede dejar de emitir eventos válidos de un día para el otro. Empezamos avisando y no rechazando.
- **Protobuf o Avro en lugar de JSON.** Dan contratos más estrictos y mensajes más chicos, pero nuestros mensajes son chicos, los clientes y las herramientas de depuración ya hablan JSON, y habría que sumar herramientas de compilación a los dos lenguajes.
- **Control manual de los cambios incompatibles en la revisión de código.** Depende de que alguien se acuerde. Es mejor que el CI los detecte.

## Consecuencias

El contrato queda explícito, versionado y consultable sin leer código ajeno. Un cambio que rompería a un consumidor falla en el pull request, antes de llegar a producción, y como los schemas se generan del código, no pueden divergir de lo que los servicios realmente publican.

Lo que asumimos es que la validación en tiempo de ejecución todavía no rechaza nada, así que un evento mal armado se detecta en el log y no se frena en el origen; endurecerla es un paso pendiente. Cada servicio tiene que actualizar la versión del contrato que usa, y los que se atrasan siguen funcionando mientras los cambios sean compatibles. Y dependemos de que quien agrega un evento lo registre en el catálogo, que es lo que alimenta la documentación de quién consume qué.
