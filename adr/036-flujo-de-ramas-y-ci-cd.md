# ADR-036: Flujo de ramas y CI/CD del equipo

**Estado:** Aceptada
**Fecha:** 2026-11-18
**Servicios:** todos los repositorios
**Relacionadas:** ADR-031 (contrato de eventos), ADR-033 (protección de ramas), ADR-034 (dónde corre cada servicio)

## Contexto

Somos siete personas trabajando en dieciséis repositorios al mismo tiempo, cada uno con su propio ritmo de cambios y su propio despliegue. Necesitamos que los cambios se integren sin pisarse, que lo que llega a producción haya pasado las pruebas y que desplegar no dependa de que alguien se acuerde de hacerlo. También necesitamos que un cambio en una librería compartida llegue a las aplicaciones que la usan.

## Decisión

Usamos dos ramas permanentes en cada repositorio. `develop` es donde se integra el trabajo y `main` es lo que está en producción. Cada cambio se hace en una rama propia (`feature/...`, `fix/...` o `docs/...`) que sale de `develop`, se abre un pull request a `develop` y, cuando pasa el CI, se mergea. Para publicar se abre otro pull request de `develop` a `main`. Ninguna rama permanente recibe empujes directos (ADR-033).

El CI corre en cada pull request y en cada empuje a `develop` o `main`. Ejecuta las pruebas con un piso de cobertura del 70% en los servicios, el formato y el análisis de código de cada lenguaje (Credo y Dialyzer en Elixir), CodeQL y Sobelow, y, donde existen, pruebas de contrato contra la API real y la comparación del contrato de eventos (ADR-031).

El despliegue está encadenado a las pruebas. En los servicios que corren en VMs, un único workflow ejecuta, en orden y con cada paso dependiendo del anterior, las pruebas, la publicación de la imagen, la migración de la base de datos y el despliegue por SSH, de modo que si la migración falla no se despliega. Render despliega `notifications` y `metrics` solo cuando pasan los checks, Vercel despliega la web y el backoffice con cada cambio, `voice-sfu` tiene un entorno de prueba que se actualiza desde `develop` y producción desde `main`, y `app-mobile` actualiza desde `develop` el servidor de desarrollo de Expo.

Las dependencias compartidas se publican solas. Cuando un cambio llega a `main` en `events-contract`, el CI crea un tag con la versión nueva, y lo mismo hace `client-shared`, que además avisa a la web y a la app para que un bot abra el pull request que sube su versión.

## Alternativas descartadas

- **Trabajar solo sobre `main`.** Es lo más simple, pero cada empuje iría directo a producción y no habría dónde juntar varios cambios antes de publicarlos.
- **Un flujo con ramas de release y de hotfix.** Da más control sobre qué sale, pero es mucho proceso para un equipo de siete personas que despliega varias veces por semana.
- **Desplegar desde `develop`.** Reduciría un paso, pero cualquier cambio a medio probar iría a producción. Lo hacemos solo donde `develop` es un entorno de prueba, como en `app-mobile` y `voice-sfu`.
- **Despliegue manual.** Evita sorpresas, pero depende de que alguien se acuerde y de que lo haga bien, que es justo lo que queremos evitar.

## Consecuencias

Todo cambio queda revisable en un pull request, con el CI en verde, y el despliegue no se puede olvidar ni saltear los pasos. Las versiones de las librerías compartidas se publican solas y las aplicaciones se enteran.

A cambio, hay costos. Promover de `develop` a `main` es un paso manual que se puede atrasar, y algunos repositorios acumulan muchos cambios sin publicar. Los pull requests que abre el bot de versiones no corren el CI hasta que alguien aprueba el workflow, así que hay que aprobarlos o traer el commit a una rama propia. Con 0 aprobaciones exigidas, la revisión entre pares es una costumbre y no una regla. Y que cada repositorio tenga su propio pipeline hace que los cambios del proceso se tengan que replicar en dieciséis lugares.
