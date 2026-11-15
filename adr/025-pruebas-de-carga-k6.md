# ADR-025: Pruebas de carga y estrés del chat en tiempo real con k6 contra el stack local

**Estado:** Aceptada  
**Fecha**: 2026-11-09  
**Servicios**: `infrastructure` (`load-test/`), `messaging`, `servers`, `gateway`  
**Relacionadas**: ADR 06 (API Gateway), ADR 10 (Load testing y rate limiting de /v1/login), ADR-014 (tickets del WebSocket), ADR-016 (fanout entre instancias), ADR-017 (réplica local por eventos), ADR-018 (outbox de messaging), ADR-023 (observabilidad)

## 1. Contexto

La consigna pide escenarios de carga y estrés sobre los endpoints críticos, incluyendo la entrega de mensajes en tiempo real, y documentar resultados, cuellos de botella y acciones. El ADR 10 cubrió el login y el listado de servidores. Faltaba el tiempo real, que es lo que más piezas atraviesa: Kong, el WebSocket de messaging, su outbox, RabbitMQ y la réplica de canales y miembros que servers le manda por eventos (ADR-017).

Las preguntas que queríamos responder:

- ¿Cuánto tarda un mensaje en llegarle a los demás, y a partir de cuántos usuarios se degrada?
- ¿Cuántos usuarios conectados a la vez aguanta el sistema?
- ¿Qué pasa si muchos usuarios entran al mismo tiempo, o si un canal tiene cientos de personas?

## 2. Decisión

### 2.1 k6 contra el stack local completo, como un cliente real

- Todo pasa por Kong y por los servicios reales en Docker, sin atajos. El script es `infrastructure/load-test/realtime-chat.js`.
- Las cuentas de prueba se crean con el flujo real: registro por la API, mail de confirmación en Mailhog y confirmación por el endpoint (`seed-users.sh` lo hace en paralelo para miles de cuentas).
- Nunca contra producción.

### 2.2 Qué se mide y qué consideramos bien

- Confirmación (`message_ack_latency`): desde que A envía hasta que messaging responde "ok". Umbral: p95 menor a 300 ms.
- Entrega (`message_delivery_latency`): desde que A envía hasta que B lo recibe. Umbral: p95 menor a 1 s. Medir las dos permite ubicar el problema: si solo sube la entrega, está del outbox en adelante.
- Conexiones al canal y envíos fallidos (`ws_join_failed`, `message_send_failed`): menos del 1%.

### 2.3 Escenarios

- `smoke` (2 usuarios), `load` (50 en un canal) y `stress` (de 50 a 300 en un canal): latencia de un canal muy activo.
- `rooms`: 1000 usuarios en grupos de 10, un mensaje cada 20 s. Prueba conexiones abiertas, no volumen de mensajes.
- `spike`: de 0 a 500 usuarios en 10 s, cada uno con su propio login, como cuando todos abren la app a la vez.
- `bigroom`: hasta 1000 usuarios en un mismo canal, para medir el costo de repartir cada mensaje a cientos de personas.
- `breakpoint`: grupos de 10 subiendo hasta 4000 usuarios. k6 corta solo si fallan más del 10% de las conexiones.

### 2.4 Cómo se observa el sistema

- `monitor.sh` anota cada 5 s el CPU y la memoria de cada servicio, los eventos pendientes del outbox, la memoria libre de la máquina y el consumo de k6, para distinguir si se satura el sistema o la máquina de prueba.
- Además: las tablas del outbox (cuánto tardó cada evento en publicarse), los logs de cada servicio y el profiler de Mongo.
- Cada cuello de botella se arregla y se repite la misma corrida. Los resultados de antes y después quedan en `load-test/results/`.

## 3. Alternativas descartadas

- Probar contra producción: las VMs son chicas y tienen usuarios reales, y una prueba de estrés podría tirar el servicio. Además la medición incluiría la red de la casa de quien la corre. Como mucho, un smoke chico después de un deploy.
- JMeter o Gatling: k6 ya se usaba (ADR 10), los scripts son JavaScript, maneja WebSockets sin plugins y se corre por consola, así que el escenario se versiona junto al resto de la infraestructura.
- Medir solo pedidos HTTP: no ve la entrega en tiempo real, que es lo que pide la consigna.
- Crear las cuentas escribiendo directo en la base: es más rápido, pero se aparta del flujo real y deja de probarlo si cambia. Se usa el flujo real en paralelo.

## 4. Consecuencias

### Qué se descubrió probándolo (y quedó corregido)

- messaging usaba una sola conexión a Mongo (el valor por defecto del driver): con 50 usuarios, confirmación p95 de 372 ms con el procesador libre. Con un pool de 10 (`MONGO_POOL_SIZE`) bajó a 71 ms.
- Kong tenía el límite por defecto de 1024 archivos abiertos, y cada WebSocket usa dos conexiones: pasados ~500 usuarios, el 82% de las conexiones fallaba. Con `ulimits: nofile: 65536` (stack local y gateway de producción), 0 fallas con 1000 usuarios.
- El outbox de servers publicaba como máximo 20 eventos cada 2 s (10 por segundo): en un pico de 500 usuarios, el 66% de las conexiones fallaba con `CHANNEL_NOT_FOUND`, porque messaging tardaba minutos en enterarse de los canales nuevos. Ahora publica todo lo pendiente en cada vuelta (tope de 2000): 0 fallas.
- messaging tenía el mismo límite de 1024 archivos abiertos: pasados ~1000 usuarios dejaba de aceptar conexiones (`out of file descriptors`) y los pedidos quedaban colgados hasta 60 s. Con `--ulimit nofile=65536:65536` en su `deploy.sh` (y en el compose local), 0 fallas hasta ~2200 usuarios.
- k6 copiaba en los JSON de resultados lo que devuelve la preparación, incluidos los tokens de sesión de los usuarios de prueba. Los scripts ahora los descartan antes de guardar (`lib/summary.js`).

### Positivas

- Con los arreglos: 1000 usuarios en un mismo canal con entrega p95 de 91 ms; 500 usuarios en 10 s con login p95 de 77 ms y 0 fallas; ~2200 usuarios conectados sin fallas y entrega p95 de 41 ms.
- Los escenarios son reproducibles y están versionados con sus resultados crudos, así que cualquier cambio se puede volver a medir con la misma corrida.

### Negativas y límites

- Todo corrió en una sola notebook (12 núcleos, 15 GB): los números no son los de producción. Lo que vale es el diagnóstico y la mejora de antes a después.
- No llegamos al punto de quiebre del sistema: k6 se queda sin memoria cerca de los 2200 usuarios (unos 2,5 MB por usuario virtual). Para ir más lejos hay que generar la carga desde otra máquina.
- Quedó como recomendación, sin aplicar: el outbox de messaging publica de a un evento y espera la confirmación de RabbitMQ por cada uno (techo de ~80 mensajes por segundo; con 300 usuarios en un canal, entrega p95 de 3,18 s). Mandar lotes con una confirmación por lote lo resolvería, pero toca la garantía de entrega (ADR-018).
- El CPU de messaging crece con los usuarios conectados: aproximadamente un núcleo cada 400. En una VM de 1 o 2 núcleos sería el primer límite, antes que cualquiera de los que encontramos.
- Hallazgo aparte: si falla el envío del mail, el registro responde 500 aunque la cuenta queda creada. No es parte de este ADR.

## 5. Seguimiento

- Confirmaciones por lote en el outbox de messaging.
- Correr `breakpoint` con k6 en otra máquina para encontrar el límite real.
- Medir el CPU de messaging en la VM de producción con el tráfico real (New Relic, ADR-023).
