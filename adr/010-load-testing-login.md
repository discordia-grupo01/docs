# ADR-010: Load testing y rate limiting de /v1/login

**Estado:** Aceptado

## Contexto

El proyecto requiere ejecutar al menos un escenario de carga simulando usuarios concurrentes sobre los endpoints críticos, documentando resultados, cuellos de botella identificados y acciones tomadas.

Se corrió un escenario con **k6** contra el stack completo (Kong + identify-service + servers), simulando hasta 30 usuarios concurrentes en dos flujos críticos:

login (POST /v1/login) y listado de servidores (GET /v1/servers). Script y resultados completos en infrastructure/load-test/

**Cuello de botella #1:** rate limiting de Kong bloqueaba usuarios legítimos

Con 30 VUs concurrentes, el 99% de los logins recibió 429 casi de inmediato.

Causa: Kong limitaba /v1/login a 10 req/min por IP, sin distinguir "30 usuarios legítimos compartiendo red" de un ataque de fuerza bruta — cualquier grupo de usuarios detrás de la misma IP (NAT, red universitaria/corporativa)

chocaba contra el mismo techo.

**Acción tomada**: se elevó el límite de Kong de 10 a 60 req/min

(gateway/kong/kong.yml.template), pero solo después de agregar una protección más precisa (ver cuello de botella #2), ya que subir el límite sin eso hubiera debilitado la única defensa contra fuerza bruta existente.

**Cuello de botella #2:** la protección contra fuerza bruta era demasiado gruesa

El límite de Kong por IP no distinguía contra qué cuenta se dirigía el ataque:

un atacante podía repartir sus intentos entre varias IPs (o varios usuarios detrás de la misma IP se veían penalizados por igual). Un bloqueo simple "por email" tampoco era aceptable: dejaría que cualquiera que supiera el email de otra persona la sacara de su propia cuenta a propósito, sin necesidad de saber la contraseña (lockout como vector de DoS).

**Acción tomada:** se implementó en identify-service un throttle por la combinación (email, IP de origen), 5 intentos fallidos en 15 minutos bloquean esa IP específica contra esa cuenta específica, verificado antes de comparar el hash (evita gastar bcrypt en pedidos que ya se sabe van a fallar).

El dueño real de la cuenta, desde su propia IP, nunca resulta afectado.

Verificado en vivo contra el gateway real: 5 fallos bloquean al atacante, pero un login correcto desde otra IP entra sin problema.

## Decisión

1. Agregar throttle por (email, ip) en identify-service (nueva tabla login_attempts), en vez de un bloqueo de cuenta o depender solo de Kong.

2. Elevar el límite de Kong en /v1/login de 10 a 60 req/min, ahora que deja de ser la única defensa contra fuerza bruta.

## Consecuencias

- Un atacante ya no puede sacar a un usuario legítimo de su propia cuenta.
- Grupos de usuarios legítimos compartiendo IP dejan de ser bloqueados por Kong en el uso normal.
- La protección contra fuerza bruta es más precisa (por cuenta atacada, no por volumen bruto de IP).
- Se agrega una tabla nueva (login_attempts) y una consulta extra por intento de login — impacto despreciable medido (login sigue dominado por bcrypt, no por esta consulta).

**Herramientas**

- k6 (carga)
- Kong Admin API (ajuste de configuración en caliente para medir capacidad real sin desactivar la protección de forma permanente).
