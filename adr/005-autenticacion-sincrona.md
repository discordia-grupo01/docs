# ADR-005: El login es una llamada sincrónica

**Estado:** Aceptado
**Servicios:** `identify-service`, `gateway` (Kong)
**Relacionadas:** ADR-006 (API Gateway), ADR-007 (mensajería pub/sub), ADR-011 (access y refresh token)

## Contexto

El enunciado dice que los servicios deben comunicarse de forma asíncrona por defecto, con eventos, y que cualquier llamada sincrónica, donde un servicio llama a otro y espera la respuesta, hay que justificarla.

El login es un caso que no se puede resolver con eventos. Cuando alguien inicia sesión, el cliente necesita recibir el token de acceso (el JWT) para poder hacer cualquier otra cosa: sin él no puede pedir nada autenticado, ni abrir un WebSocket, ni recibir mensajes. Además, `identify-service` tiene todo lo que necesita para resolverlo solo, porque guarda los usuarios, las contraseñas y las sesiones.

## Decisión

El login es sincrónico. El cliente manda su correo y su contraseña a `POST /v1/login`, Kong lo enruta a `identify-service`, y este responde en la misma conexión con el token. No interviene ningún otro servicio.

Después del login, los pedidos siguientes llevan ese token y es Kong quien lo comprueba, sin llamar a nadie. El token se firma con un secreto que conocen `identify-service` y Kong, así que Kong puede verificar la firma y la fecha de vencimiento por su cuenta. Los demás servicios confían en lo que Kong ya validó.

El login también está protegido contra abuso en dos niveles. `identify-service` bloquea los intentos repetidos con la misma combinación de correo e IP, y Kong limita cuántos pedidos de login por minuto acepta de cada IP.

## Alternativas descartadas

- **Hacer el login asincrónico.** Habría que publicar un evento de "login pedido" y esperar la respuesta por otro lado. No ganaríamos nada, porque el cliente no puede seguir hasta tener el token, y se complicaría el flujo para el usuario.
- **Que cada servicio le pregunte a `identify-service` si el token es válido en cada pedido.** Sería una llamada sincrónica más por cada pedido que llega al sistema, y si `identify-service` se cae, dejaría de funcionar todo, no solo el login. Con la validación en Kong, un token válido sigue sirviendo aunque `identify-service` no esté.

## Consecuencias

El cliente obtiene su token en un solo pedido y sin pasos intermedios. El login no depende de otros servicios, así que sus fallos quedan aislados, y los pedidos autenticados se validan en el gateway sin ninguna llamada de red hacia identidad.

A cambio, si `identify-service` no está disponible nadie puede iniciar sesión, aunque quienes ya tienen un token válido siguen funcionando hasta que venza. El hash de la contraseña es deliberadamente lento, lo que limita cuántos logins simultáneos aguanta el servicio, y es parte de la razón del límite por IP en Kong. Y como el secreto de firma lo conocen `identify-service` y Kong, cambiarlo implica actualizar y reiniciar los dos.
