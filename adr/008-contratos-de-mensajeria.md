# ADR-008: Contratos de Mensajería

RabbitMQ no tiene en cuenta el contenido del mensaje: transporta bytes, no valida estructura. Sin un contrato explícito, cada servicio interpreta el payload por una convención no asentada, generando expectativas diversas en los eventos, necesidades de lectura de codigo entre microservicios diferentes y fallas inesperadas.

## Decisión

Cada evento tiene un **JSON Schema versionado** que vive en discordia-docs bajo schemas/<épica>/<accion>.v<N>.json, documentado además con AsyncAPI (análogo a OpenAPI pero para mensajería asíncrona), que describe el exchange, las routing keys, el payload de cada evento y quién lo publica/consume. El publisher valida el payload contra el schema antes de publicar (falla rápido, cerca del origen del error). El repositorio discordia-docs es la única fuente de verdad del contrato; ningún servicio define la forma de un evento en el código sin que primero exista en el schema versionado.

**Agregar un campo nuevo:** siempre opcional, con valor por default asumible por el consumidor si falta (null o equivalente). No incrementa la versión mayor del evento; los consumidores que no se actualizaron simplemente ignoran el campo nuevo

**Sacar o cambiar el tipo de un campo existente:** se considera **breaking change**. Requiere una nueva versión mayor del evento (v2) publicada en paralelo a la anterior durante un período de transición.

- **¿Quién define la forma del mensaje?** El publisher, porque es el dueño del evento de dominio. El schema se declara en discordia-docs antes de implementarse en código; no se publica un evento cuyo schema no esté versionado ahí.
- **¿Si agregan un campo nuevo en 6 meses, los consumidores no actualizados se rompen?** No, mientras el campo sea opcional. JSON ignora campos desconocidos por naturaleza, así que un consumidor viejo simplemente no lo ve. Todo campo nuevo nace opcional.
- **¿Si sacan un campo que otro servicio usaba, cómo se enteran antes de romper producción?** El AsyncAPI de cada evento lista explícitamente qué servicios lo consumen (sección consumers), completada por cada equipo al sumarse como consumidor. Sacar o modificar un campo obliga a crear una versión mayor nueva que coexista temporalmente. La detección es manual, no automática
- **¿Si un evento tiene un campo mal tipado o faltante, cuándo se dan cuenta: al publicar, al consumir o nunca?** Al publicar. El publisher valida el payload contra el JSON Schema antes de mandarlo a RabbitMQ; si no cumple, no se publica y falla ahí mismo, con el stack trace en el servicio que originó el problema (no en el consumidor, que vería un síntoma sin contexto). Asimismo, en caso de que sea enviado igualmente se cuenta con una DLQ que ante mensajes bugeados agrega al mismo a una cola de mensajes muertos luego de una serie de reintentos de envío.
- **¿Confían en que todos manden lo que dice la documentación, o necesitan algo que lo garantice?** La validación contra JSON Schema en el publisher es el mecanismo. No es tan fuerte como un schema registry centralizado (que rechazaría el mensaje incluso si el publisher se olvidó de validar), pero es consistente con la decisión de no sumar esa complejidad operativa.
- **¿Si un servicio nuevo se quiere sumar a escuchar un evento en un año, de dónde saca la información?** De discordia-docs: el Async API describe exchange, routing key y schema completo de cada evento, sin necesidad de leer el código fuente de otro equipo. Al sumarse, agrega su nombre a la sección consumers del evento correspondiente, para que futuros cambios breaking lo tengan en cuenta.
- **¿Conocen alguna herramienta para documentar APIs async, tipo Swagger/OpenAPI?** Sí, **Async API**, que se adopta en esta decisión como formato de documentación de los eventos de discordia.events, en paralelo al contrato OpenAPI ya usado para la API REST.
- **¿El evento representa un hecho consumado o una orden? ¿Cambia cómo lo tratan los consumidores?** Representa siempre un hecho consumado (de ahí el naming en pasado, <épica>.<acción>). El consumidor nunca está obligado a actuar ni el publisher espera una respuesta; esto evita acoplamiento tipo request/response disfrazado de evento.

## Consecuencias

**Positivas:**

- Contrato explícito y versionado en un único lugar (discordia-docs), consultable sin leer código ajeno.
- Falla rápida: un payload mal formado se detecta al publicar, no se propaga a consumidores.
- Compatibilidad hacia atrás garantizada por convención simple (campos nuevos siempre opcionales), sin infraestructura adicional.
- AsyncAPI documenta consumidores por evento, dando trazabilidad de impacto ante un cambio.
- Coherente con la decisión de bajo overhead operativo.

**Negativas:**

- La validación depende de que cada publisher la implemente correctamente; no hay un broker o registry que la fuerce de forma centralizada como en Kafka + Confluent Schema Registry.
- La detección de breaking changes depende de que la sección consumers del Async API esté actualizada y de que se respete el proceso en code review; es un control de proceso humano, no automático.
- Si discordia-docs se desactualiza (schema real del código diverge del documentado), el contrato pierde valor como fuente de verdad; se evalúa a futuro un test de contrato automatizado (ej. validar en CI que el payload real emitido por cada servicio matchea su schema declarado) si el desvío se vuelve un problema recurrente.
- La convivencia de dos versiones de un mismo evento durante la transición de un breaking change agrega complejidad temporal a los publishers.
