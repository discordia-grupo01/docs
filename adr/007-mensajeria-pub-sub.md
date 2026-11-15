# ADR-007: Mensajería Pub/Sub

**Estado:** Esperando aceptación

## Contexto

El enunciado exige que la comunicación *entre servicios* backend sea asíncrona por defecto (eventos/colas), salvo excepciones ya justificadas. Se necesita un mecanismo de pub/sub para que eventos de dominio (ej. moderation.member_banned, users.registered) se propaguen entre servicios sin acoplamiento directo, con al menos una instancia de cada servicio corriendo en paralelo, y los consumidores deben ser idempotentes ante duplicados o desorden. Se evaluaron: **Redis Pub/Sub** (ya usado puntualmente dentro de Elixir para difundir mensajes en tiempo real entre nodos de Phoenix, pero sin persistencia, un evento sin consumidor conectado en ese instante se pierde para siempre, inaceptable para eventos de negocio), **Kafka** (mejor throughput y replay nativo de eventos, pero exige operar Zookeeper/KRaft y particiones, complejidad operativa que no se justifica para el volumen esperado de un TP), **NATS/JetStream** (liviano, pero la capa de persistencia agrega una complejidad similar a Kafka sin su ecosistema) y **RabbitMQ** (ya indicado en la tabla de stack, exchanges tipo topic calzan naturalmente con el patrón <épica>.<acción> del contrato de API, colas durables con ack manual dan entrega confiable, y es liviano de correr junto a los demás servicios en el VM de infra).

## Decisión

Adoptar **RabbitMQ** como bus de eventos asíncrono entre servicios backend, con un exchange tipo topic (discordia.events) y routing keys <épica>.<acción> en pasado, igual a como ya se definieron los nombres de evento en el contrato de API. Cada servicio consumidor declara su propia cola durable con binding a los routing keys que le interesan.

Respuesta puntual a las preguntas planteadas por la cátedra sobre esta decisión:

- **¿Qué pasa si el mensaje se pierde?** No se pierde: Colas durables + mensajes persistentes (delivery_mode=2) + ack manual del consumidor (nunca autoack). Si el consumidor se cae antes de enviar ack, RabbitMQ vuelve a encolar el mensaje.
- **¿Y si el servicio destino está caído al publicar?** El exchange y la cola existen independientemente del estado del consumidor; el mensaje queda encolado hasta que el consumidor vuelva a levantar. Si el broker mismo no está disponible, el publisher loguea el fallo (se evalúa un outbox pattern si en la práctica aparecen inconsistencias).
- **¿Alcanza con solo enviar?** No, se necesita ack manual del consumidor para confirmar procesamiento; publicar sin confirmación no cumple el requisito de no perder eventos.
- **¿Escala con más consumidores?** Sí, de dos formas según el caso: *Competing consumers* (varios workers leyendo la misma cola, RabbitMQ reparte round-robin) cuando alcanza con que uno solo procese el evento; una cola por servicio bindeada al mismo routing key cuando varios servicios distintos necesitan ver el mismo evento.
- **¿Importa el orden de llegada?** RabbitMQ garantiza FIFO dentro de una única cola con un único consumidor activo, pero no entre colas ni con múltiples consumers en paralelo sobre la misma cola. Los consumidores deben ser tolerantes a desorden razonable (verificar versión/timestamp del recurso antes de aplicar un evento, nunca asumir que UserCreated siempre llega antes que UserUpdated).
- **¿Eventos contradictorios en paralelo?** Se resuelven en el consumidor con chequeo de versión/estado antes de aplicar el efecto (idempotencia + last-write-wins por timestamp donde corresponda).
- **¿Se puede reproducir qué pasó?** RabbitMQ no retiene mensajes ya consumidos, así que no hay replay nativo. discordia-docs documenta el schema de cada evento como contrato; se evalúa además persistir un log de auditoría de eventos procesados.
- **¿Solución ante mensajes corruptos enviados indefinidamente?** Política de DLQ (después de N reintentos, mover a una cola de errores) para poder operar esto en producción sin que un solo mensaje malo tire abajo el procesamiento del resto.

## Consecuencias

- **Positivas**:
    - Cumple el requisito de comunicación asíncrona por defecto entre servicios.
    - El patrón de exchange topic + routing key calza exactamente con la convención <épica>.<acción> ya acordada en el contrato de API.
    - Colas durables + ack manual dan entrega *at-least-once* sin perder eventos ante caídas de consumidor.
    - Escala horizontalmente cada servicio consumidor sin cambiar el modelo de publicación.
    - Ya contemplado en la tabla de stack del grupo; corre liviano tanto self-hosteado en el VM como en CloudAMQP.
- **Negativas**:
    - Sin replay nativo de eventos ya consumidos (a diferencia de Kafka), si se necesita reconstruir historia hay que loguearla aparte.
    - El free tier de CloudAMQP limita a 20 conexiones concurrentes; con 10-12 servicios manteniendo una conexión persistente cada uno, el margen es ajustado (mitigar reusando channels sobre una sola conexión por servicio, o self-hosteando RabbitMQ en el VM si se supera el límite).
    - Entrega *at-least-once* exige que todo consumidor sea idempotente ante duplicados, ya exigido por el enunciado, pero es una responsabilidad extra explícita de cada servicio.
    - Suma un componente más para operar y monitorear.
