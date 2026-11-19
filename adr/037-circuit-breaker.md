# ADR-037: Circuit breaker en las llamadas síncronas hacia afuera

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** `servers`, `identify-service`, `billing`, `messaging`, `notifications`, `voice-sfu`
**Relacionadas:** ADR-017 (réplica local), ADR-018 (outbox), ADR-030 (reintentos y entrega de eventos)

## Contexto

La consigna pide reintentos con espera exponencial y circuit breaker para evitar las cascadas de fallos, con los patrones elegidos y justificados en un ADR. Los reintentos ya los teníamos, y nos hacen falta justamente porque a veces una llamada falla una vez y sale bien la siguiente (ADR-030). Pero un reintento no protege cuando el otro lado está caído de verdad: cada pedido sigue esperando hasta que vence su tiempo de espera, esos pedidos colgados se acumulan, y el servicio que llama termina sin hilos ni conexiones libres aunque su propio código esté sano. Eso es una cascada de fallos.

Entre nuestros servicios casi no quedan llamadas síncronas, porque se hablan por eventos y cada uno guarda su propia copia de lo que necesita de los demás (ADR-017). Las llamadas síncronas que sí hay van hacia proveedores externos o hacia un servicio vecino que no podemos reemplazar por un evento:

- `servers`, `identify-service` y `messaging` suben y borran archivos en Supabase Storage.
- `messaging` sube adjuntos a Cloudinary.
- `billing` llama a Mercado Pago para cobrar y consultar pagos.
- `notifications` envía los push a Expo y a los servicios de Web Push.
- `voice-sfu` llama a LiveKit y consulta a `servers` quién puede entrar a un canal.

## Decisión

Cada una de esas llamadas pasa por un circuit breaker, que cuenta los fallos seguidos de ese destino. Al llegar a 5, el circuito se abre y durante 30 segundos las llamadas fallan al instante, sin salir a la red. Pasado ese tiempo se deja pasar una sola llamada de prueba: si sale bien, el circuito se cierra y todo vuelve a la normalidad, y si falla, se abre de nuevo por otros 30 segundos. Los valores son los mismos en todos los servicios, y se pueden cambiar al crear cada breaker.

Cuenta como fallo que la llamada no se pueda hacer o expire, que el destino responda con un error 5xx o que responda 429, que es un pedido de esperar. No cuenta una respuesta 4xx, porque dice que el pedido estaba mal y no que el destino esté caído, ni una llamada cancelada por quien la hizo. Un destino que no existe, como un archivo que ya no está, no debe abrir el circuito.

Cada destino tiene su propio breaker, de modo que un Expo caído no frene a Mercado Pago. En `notifications`, donde los destinos de Web Push son muchos, el breaker es por host y puerto, para que un servicio de push caído no bloquee a los demás. Cuando el circuito está abierto, el error se trata como cualquier otro fallo de esa llamada: un push se reintenta con la espera de siempre y se da por perdido después de varios intentos, una subida de archivo responde un error al usuario, y un pedido a Mercado Pago falla como cualquier otro error de ese proveedor. Cada cambio de estado queda en el log como `circuit_breaker_state_changed`, con el destino y los estados de origen y de destino.

El breaker va por fuera de los reintentos que ya tiene cada cliente, de manera que cuenta cada llamada lógica una sola vez, después de agotar sus reintentos.

Lo escribimos nosotros, en dos copias chicas: un paquete `internal/circuitbreaker` en cada servicio en Go y un módulo `CircuitBreaker` en cada servicio en Elixir, con la misma lógica y las mismas pruebas, y sin dependencias nuevas. En Go se envuelve el cliente HTTP, y en Elixir la llamada completa. El estado vive en memoria de cada instancia.

No lo aplicamos a todo, y es a propósito. No lo ponemos en las llamadas entre nuestros servicios, porque casi no quedan y las que quedan son eventos. Tampoco en el envío de logs a New Relic, que ya tiene reintentos y una cola acotada que descarta lo más viejo, y donde perder logs es el fallo seguro. Ni en los chequeos de salud de `voice-sfu` y `metrics`, cuyo trabajo es justamente observar si el otro lado responde, y un breaker lo escondería. Y no en RabbitMQ ni en las bases de datos, cuyos clientes ya administran sus conexiones y las reconectan solos, y donde el outbox cubre la publicación (ADR-018).

## Alternativas descartadas

- **Seguir solo con tiempos de espera y reintentos.** Es lo que teníamos. Protege de una falla pasajera, pero no de un destino caído, donde cada pedido paga el tiempo de espera completo.
- **Una librería, como `gobreaker` en Go o `fuse` en Erlang.** Son opciones válidas y bien probadas. Preferimos código propio porque son unas pocas decenas de líneas, se comporta igual en los dos lenguajes, se prueba con un reloj inyectado sin esperar 30 segundos y no suma dependencias a ocho repositorios.
- **Que el gateway haga de circuit breaker.** Kong protege los pedidos que entran desde los clientes, pero no las llamadas que salen de un servicio hacia afuera, que son las que fallan en cascada.
- **Un service mesh o un proxy de salida.** Resuelve el problema sin tocar el código, pero es mucha infraestructura para operar con planes gratuitos.
- **Un único breaker para todos los destinos de un servicio.** Es más simple, pero un proveedor caído dejaría sin servicio a los demás.

## Consecuencias

Cuando un destino cae, el servicio que lo llama deja de gastar hilos y conexiones en esperar, responde un error enseguida y se recupera solo cuando el destino vuelve. En el caso de los push, además, se reduce la carga sobre un proveedor que ya está en problemas.

Hay límites. El estado es por instancia y por proceso: cada instancia cuenta sus fallos por separado, y un reinicio lo pone a cero. Los valores están fijos en el código y no se cambian por variable de entorno. Cinco fallos seguidos, aunque sean de un destino sano que tuvo un mal momento, cortan las llamadas durante 30 segundos. Y todavía no hay una alerta cuando un circuito se abre: hoy se ve en el log, y el paso siguiente es una alerta en New Relic sobre `circuit_breaker_state_changed`.

Al hacerlo encontramos que `identify-service` llamaba a Supabase Storage con el cliente HTTP por defecto de Go, que no tiene tiempo de espera, de modo que una llamada colgada nunca fallaba y el breaker nunca habría contado nada. Ahora tiene 10 segundos, igual que `servers`.
