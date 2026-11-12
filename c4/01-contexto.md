# C4 nivel 1: contexto del sistema

Muestra Discordia como una caja negra: quién la usa y con qué sistemas de terceros habla. No muestra tecnologías ni servicios internos (eso está en el [nivel 2](02-contenedores.md)).

```mermaid
C4Context
    title Contexto del sistema: Discordia

    Person(usuario, "Usuario", "Persona que se registra, crea o se une a servidores, chatea, habla por voz y puede comprar Premium.")
    Person(staff, "Staff de la plataforma", "Personal de Discordia que modera la plataforma: suspende cuentas y servidores y mira métricas globales.")

    System(discordia, "Discordia", "Plataforma de comunidades con servidores, canales de texto y voz, mensajes directos, notificaciones, puntos y Premium.")

    System_Ext(mercadopago, "Mercado Pago", "Cobra la suscripción Premium y la compra de puntos, y avisa el resultado por webhook.")
    System_Ext(google, "Google", "Inicio de sesión con OAuth.")
    System_Ext(correo, "Proveedor de correo (SMTP)", "Entrega los mails de confirmación de cuenta y de recupero de contraseña.")
    System_Ext(push, "Servicios de push", "Web Push (VAPID) para navegadores y Expo Push para la app móvil.")
    System_Ext(cloudinary, "Cloudinary", "Guarda los adjuntos de los mensajes hasta el límite del plan gratuito.")
    System_Ext(newrelic, "New Relic", "Recibe trazas, métricas y logs de todos los servicios (OpenTelemetry).")

    Rel(usuario, discordia, "Chatea, habla por voz, administra servidores y compra Premium", "Web, app móvil, HTTPS y WebSocket")
    Rel(staff, discordia, "Suspende cuentas y servidores, revisa reportes y métricas", "Backoffice, HTTPS")

    Rel(discordia, mercadopago, "Crea cobros y suscripciones, consulta su estado y reembolsa", "HTTPS")
    Rel(mercadopago, discordia, "Notifica el pago", "Webhook HTTPS")
    Rel(discordia, google, "Valida la identidad del usuario", "OAuth 2.0")
    Rel(discordia, correo, "Envía mails", "SMTP")
    Rel(discordia, push, "Envía avisos al dispositivo", "HTTPS")
    Rel(discordia, cloudinary, "Sube y sirve adjuntos", "HTTPS firmado")
    Rel(discordia, newrelic, "Envía telemetría", "OTLP sobre HTTPS")
```

## Quién interactúa

| Actor | Qué hace con el sistema |
|---|---|
| Usuario | Es quien usa la aplicación web o la móvil. Un mismo usuario puede ser dueño de un servidor, moderador o miembro común, según los roles y permisos que tenga en cada servidor. |
| Staff de la plataforma | Entra por el backoffice, que es un cliente aparte. Los permisos de staff son de plataforma, no de un servidor. |

## Sistemas externos

| Sistema | Para qué lo usamos | Cómo se integra |
|---|---|---|
| Mercado Pago | Cobrar Premium y puntos | `billing` crea el cobro o la suscripción y recibe el webhook en una ruta pública del gateway, que no exige JWT porque Mercado Pago no lo manda. |
| Google | Iniciar sesión | `identify-service` valida el código de OAuth. |
| Proveedor de correo | Confirmar la cuenta y recuperar la contraseña | `identify-service` envía por SMTP. |
| Servicios de push | Avisar de menciones y mensajes con la app cerrada | `notifications` envía a los navegadores (Web Push con claves VAPID) y a los celulares (Expo Push). |
| Cloudinary | Adjuntos chicos de mensajes | `messaging` sube con una firma y la URL queda en el mensaje. Los adjuntos grandes (Premium) van a Supabase Storage, que es parte del sistema (ver nivel 2). |
| New Relic | Observabilidad | Los ocho servicios exportan por OpenTelemetry. |

Las bases de datos (Supabase y MongoDB Atlas) y la mensajería (RabbitMQ) son parte del sistema, no sistemas externos de otro dueño: aparecen en el [nivel 2](02-contenedores.md).
