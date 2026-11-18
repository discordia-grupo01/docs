# ADR-033: Protección de ramas, endurecimiento de Actions y análisis estático de seguridad

**Estado:** Aceptada
**Fecha:** 2026-11-09
**Servicios:** todos los repositorios (16 públicos)
**Relacionadas:** ADR-036 (flujo de ramas y CI/CD)

## Contexto

La consigna pide que el merge se bloquee cuando el CI falla y recomienda análisis estático de seguridad (SAST). Hasta entonces, cualquiera de los siete integrantes podía empujar directo a `main`, y `main` es lo que despliega a producción. No había SAST en ningún repositorio, ni se escaneaban secretos.

Había además una restricción: los repositorios eran privados en un plan gratuito, y GitHub no permite proteger ramas ni usar CodeQL con resultados en la pestaña de seguridad en repositorios privados sin pagar. Los minutos de Actions de los repositorios privados también eran un límite real, con 2.000 minutos mensuales en la organización.

## Decisión

Pasamos los repositorios a públicos, con lo que obtenemos protección de ramas, CodeQL y minutos de Actions sin límite práctico, y sobre eso configuramos tres cosas.

Primero, un ruleset llamado "Proteger main" en cada repositorio: no se puede borrar la rama ni hacer force push, todo entra por pull request, y deben pasar el check requerido del CI y la regla de análisis de código de CodeQL. No exigimos aprobaciones (0 en la regla), porque somos un equipo chico y cada uno es dueño de partes distintas; lo que protegemos es que nada llegue a `main` sin pasar por un pull request con el CI en verde.

Segundo, endurecimos GitHub Actions: el token de los workflows es de solo lectura por defecto, cada repositorio tiene una lista de acciones permitidas, los workflows de contribuyentes externos necesitan aprobación manual y está activado el escaneo de secretos.

Tercero, análisis estático: CodeQL en configuración por defecto para Go, TypeScript y los propios workflows, y Sobelow en el CI de los servicios en Elixir (`notifications`, `messaging` y la señalización de `voice-sfu`). Cada acción de terceros nueva hay que sumarla a la lista de permitidas del repositorio.

Hay una excepción: `client-shared` no exige pull request ni la regla de CodeQL, porque su workflow de versionado empuja el commit de la versión directo a `main`. Tampoco el repositorio `infrastructure`, que sigue privado.

## Alternativas descartadas

- **Pagar GitHub Pro o pedir el plan a la cátedra.** Habría permitido proteger los repositorios privados, pero es un gasto que el equipo no tiene y habría que haberlo pedido a la cátedra.
- **No proteger las ramas y apoyarnos en que el despliegue espera a los tests.** Es lo que había en los repositorios con `needs` entre jobs, pero no impide que alguien empuje a `main` ni que se salte el CI.
- **Herramientas de línea de comandos en lugar de CodeQL (`gosec`, `govulncheck`, `gitleaks`, `trivy`).** Funcionan en repositorios privados, pero son varias herramientas por lenguaje y no dejan resultados en la pestaña de seguridad. CodeQL cubre Go, TypeScript y los workflows con una sola configuración.
- **Exigir aprobaciones de otro integrante.** Sería mejor control, pero con tantos repositorios y tan pocas personas por área enlentecería cada cambio sin una ganancia clara para este proyecto.

## Consecuencias

Nada llega a `main` sin un pull request y un CI verde, el CI de CodeQL y Sobelow se ejecuta sobre cada cambio y se escanean secretos. Un workflow comprometido o una acción de terceros nueva no pueden ejecutar nada sin que alguien los apruebe.

Como contrapartida, el código del proyecto es público, de modo que cualquier secreto que se cuele queda a la vista. Por eso importa el escaneo de secretos, y lo que es público por diseño, como el `google-services.json` de la app, no se oculta. Con 0 aprobaciones, la revisión entre pares depende de la costumbre del equipo y no de una regla. Los siete integrantes son administradores y pueden editar los rulesets, así que no es una barrera contra un error deliberado. Y si un merge falla con un error de GitHub, hay que comprobar que el commit esté en `main` y que el despliegue exista antes de repetirlo.
