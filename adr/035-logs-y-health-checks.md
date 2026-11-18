# ADR-035: Logs estructurados en JSON y chequeos de salud separados

**Estado:** Aceptada
**Fecha:** 2026-11-07
**Servicios:** los ocho servicios de backend
**Relacionadas:** ADR-023 (observabilidad), ADR-030 (entrega de eventos)

## Contexto

La consigna pide que los servicios tengan chequeos de salud separados para saber si el proceso está vivo y si puede atender pedidos, y logs estructurados con niveles configurables que no expongan datos privados. Cada servicio escribía sus logs a su manera, con texto libre, sin nivel configurable y, en algunos casos, con datos que no deberían estar en un log, como correos o tokens. Y varios servicios tenían un solo endpoint de salud, que mezclaba "el proceso está vivo" con "puede atender".

## Decisión

Todos los servicios escriben logs en JSON, una línea por evento, con un nivel configurable con la variable `LOG_LEVEL`. En Go hay un paquete `internal/logging` idéntico en cada repositorio, y en Elixir un formateador JSON compartido entre `messaging`, `notifications` y `voice-sfu`. Antes de escribir, el log oculta los campos sensibles (como `password`, `token`, `ticket`, `email` o `content`) y los correos y JWT que aparezcan dentro de un texto, y el middleware HTTP registra el patrón de la ruta y no la ruta real, que lleva ids.

Cada servicio expone dos endpoints distintos. `/livez` contesta que el proceso está vivo, sin mirar nada más, y sirve para decidir si hay que reiniciarlo. `/readyz` contesta si puede atender pedidos, y por eso comprueba sus dependencias esenciales: la base de datos en los servicios con base, LiveKit y el `/livez` de `servers` en `voice-sfu`. Una respuesta 503 de `/readyz` se registra como error.

Hay una decisión que dejamos a propósito: `/readyz` no mira a RabbitMQ en la mayoría de los servicios. Si un servicio no puede publicar un evento, igual puede atender pedidos, porque el outbox guarda el evento hasta que el broker vuelva (ADR-030). Hacer que `/readyz` falle por RabbitMQ sacaría de rotación a servicios sanos. Solo `admin` lo comprueba, y consultaremos con el corrector si esta decisión es defendible.

## Alternativas descartadas

- **Un solo endpoint de salud.** No distingue entre un proceso que hay que reiniciar y uno que solo está esperando a su base de datos.
- **Que `/readyz` compruebe también RabbitMQ en todos los servicios.** Detectaría antes un broker caído, pero un corte de RabbitMQ dejaría fuera de servicio a todo el sistema, aunque los servicios siguen funcionando gracias al outbox.
- **Logs de texto libre.** Más fáciles de leer a simple vista, pero no se pueden filtrar ni buscar por campos en New Relic, y no permiten saneado automático.
- **Un paquete de logs compartido entre servicios.** Evitaría mantener copias, pero cada repositorio es un módulo independiente, así que hay una copia por repositorio.

## Consecuencias

Los logs se pueden filtrar y relacionar con las trazas (ADR-023), no contienen datos sensibles por construcción y se ajusta el detalle sin redesplegar código. Cada plataforma puede usar el endpoint que le corresponde para reiniciar o sacar de rotación una instancia.

Lo que asumimos es mantener una copia del paquete de logs por cada servicio en Go y una en Elixir. En `voice-sfu`, el chequeo de salud de Fly usa `/readyz`, que mira a LiveKit y a `servers`, así que una caída de cualquiera de los dos saca la máquina de rotación; falta decidir con quienes mantienen ese servicio si el chequeo de Fly debería usar `/livez`.
