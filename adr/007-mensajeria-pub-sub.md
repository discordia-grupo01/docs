# ADR-007: Mensajería Pub/Sub

**Estado:** Aceptado
**Servicios:** todos, con RabbitMQ en `rabbit-mq` y `infrastructure`
**Relacionadas:** ADR-008 (contratos), ADR-018 (outbox), ADR-030 (entrega de eventos), ADR-034 (dónde corre cada cosa)

## Contexto

El enunciado exige que la comunicación entre servicios sea asíncrona por defecto, con eventos o colas, salvo las excepciones que se justifiquen. Necesitábamos un mecanismo de pub/sub para que los hechos del dominio, como un baneo o el alta de un usuario, se propaguen entre servicios sin acoplarlos directamente, con al menos una instancia de cada uno corriendo, y con consumidores que toleren duplicados y desorden.

Evaluamos cuatro opciones. Redis Pub/Sub ya lo usábamos dentro de Elixir, pero no guarda nada: un evento sin consumidor conectado en ese instante se pierde para siempre, y eso es inaceptable para eventos de negocio. Kafka tiene mejor throughput y repetición nativa, pero exige operar particiones y un coordinador, una complejidad que no se justifica para el volumen de un proyecto como este. NATS con JetStream es liviano, pero la capa de persistencia agrega una complejidad parecida a la de Kafka sin su ecosistema. Y RabbitMQ estaba en la tabla de stack del grupo, tiene exchanges de tipo topic que calzan con nombres de evento como `servers.channel_created`, colas durables con confirmación manual y es liviano de correr junto al resto.

## Decisión

Usamos RabbitMQ como bus de eventos entre servicios. Hay un exchange de tipo topic, `discordia.events`, y los eventos se publican con una routing key `<servicio>.<hecho en pasado>`, por ejemplo `servers.channel_created` o `users.profile_updated`. Cada servicio que consume declara su propia cola durable, enlazada a las routing keys que le interesan. Los mensajes son persistentes y el consumidor confirma manualmente (nunca con autoack) recién cuando terminó de procesar. RabbitMQ lo operamos nosotros, en una VM propia, y no con un servicio administrado como CloudAMQP.

Un evento es siempre un hecho consumado, no una orden. El consumidor no está obligado a actuar y el publicador no espera respuesta, para no esconder un request/response detrás de un evento.

Las preguntas de la cátedra sobre esta decisión las respondimos así:

- **Si el mensaje se pierde.** No debería perderse: las colas son durables, los mensajes persistentes y la confirmación es manual. Si el consumidor se cae antes de confirmar, RabbitMQ vuelve a encolar el mensaje. Y si el que no está disponible es el propio broker al publicar, el evento queda anotado en el outbox de quien lo emite y sale cuando RabbitMQ vuelve (ADR-018).
- **Si el servicio destino está caído al publicar.** El exchange y la cola existen aunque el consumidor no esté, así que el mensaje espera hasta que levante.
- **Si alcanza con solo enviar.** No. Hace falta la confirmación del consumidor, y del lado del publicador las confirmaciones del broker; publicar sin confirmación no cumple el requisito de no perder eventos.
- **Si escala con más consumidores.** Sí, de dos maneras: varios workers sobre la misma cola, que RabbitMQ reparte, cuando alcanza con que uno solo procese el evento, y una cola por servicio con el mismo binding cuando varios servicios necesitan verlo.
- **Si importa el orden.** RabbitMQ garantiza el orden dentro de una cola con un único consumidor, pero no entre colas ni con consumidores en paralelo. Por eso los consumidores no asumen orden: cada uno compara una versión o una fecha del recurso antes de aplicar un evento (ADR-017).
- **Eventos contradictorios en paralelo.** Se resuelven en el consumidor, con idempotencia y última escritura por fecha donde corresponde.
- **Si se puede reproducir lo que pasó.** RabbitMQ no guarda lo ya consumido, así que no hay replay nativo. Cada evento está documentado como contrato (ADR-008), y los consumidores que lo necesitan guardan una auditoría de lo que procesaron.
- **Mensajes corruptos que se reenvían para siempre.** Después de 5 intentos con espera creciente, el evento se aparta a una cola de eventos muertos y deja de bloquear a los que vienen detrás (ADR-030).

## Alternativas descartadas

- **Redis Pub/Sub.** Sin persistencia, un evento sin consumidor en ese momento se pierde.
- **Kafka.** Más potente y con repetición, pero hay que operar particiones y un coordinador, desproporcionado para nuestro volumen.
- **NATS con JetStream.** Liviano, pero la persistencia agrega una complejidad parecida a la de Kafka sin su ecosistema.
- **RabbitMQ administrado en CloudAMQP, en lugar de correrlo en una VM propia.** Lo evaluamos porque nos ahorraba operarlo, pero el plan gratuito limita a 20 conexiones simultáneas, y con unos diez servicios con una conexión persistente cada uno el margen era demasiado ajustado. Correrlo nosotros en una VM no tiene ese límite.

## Consecuencias

Cumplimos el requisito de comunicación asíncrona, el patrón de exchange topic encaja con los nombres de evento que definimos, las colas durables con confirmación manual dan entrega "al menos una vez" sin perder eventos cuando un consumidor se cae, y cada servicio consumidor puede escalar sin cambiar cómo se publica.

El costo es que no hay repetición de eventos ya consumidos, a diferencia de Kafka, así que reconstruir historia exige haberla guardado aparte. La entrega "al menos una vez" obliga a que todo consumidor tolere duplicados, una responsabilidad extra y explícita de cada servicio. Y sumamos un componente más para operar y vigilar: cuando RabbitMQ pierde su identidad o sus usuarios, varios servicios dejan de recibir eventos sin que ninguno se caiga, como nos pasó en noviembre (ADR-034).
