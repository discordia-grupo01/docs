# ADR-009: Almacenamiento de archivos en un servicio de objetos

**Estado:** Aceptado
**Fecha:** 2026-09-12 (actualizado con los adjuntos el 2026-10-13)
**Servicios:** `identify-service`, `servers`, `messaging`
**Relacionadas:** ADR-004 (persistencia y aislamiento de datos de cada servicio)

## Contexto

Los archivos que generan los usuarios, como los avatares, los íconos y banners de los servidores y, más tarde, los adjuntos de los mensajes, se guardaban al principio en carpetas dentro de las VMs donde corre cada servicio. Eso traía varios problemas. Los archivos quedaban atados al ciclo de vida de la VM: si se recrea, se migra o falla el disco, hay que moverlos a mano o se pierden. Varias instancias de un mismo servicio no comparten el sistema de archivos, así que los archivos quedan en una sola máquina y no se puede escalar. Para servirlos hay que exponerlos desde la VM o programar endpoints propios. Y cada VM necesita su propia estrategia de respaldo.

## Decisión

Los servicios dejan de guardar archivos en el disco y usan un servicio de objetos externo. En la base de datos se guarda solamente la referencia, la ruta o la URL, nunca el archivo, de modo que las VMs quedan sin estado respecto de los archivos de los usuarios.

Para los avatares, los íconos y los banners usamos Supabase Storage, en buckets separados por tipo de contenido (por ejemplo `profile-images` para los avatares). Los buckets son públicos, porque se trata de contenido no sensible que se sirve por CDN, y las rutas llevan el identificador del dueño. Los límites los controla el propio servicio: 5 MiB para un avatar o un ícono. En local los servicios siguen pudiendo guardar en una carpeta, que es lo que se usa en desarrollo.

Los adjuntos de los mensajes van a dos destinos según el tamaño, con la lógica en un módulo de `messaging` (`Messaging.Storage.Tiered`). Hasta 10 MB, el límite de un adjunto común, se suben a Cloudinary, que es también su tope por archivo en el plan gratuito. Los más grandes, que solo permiten los planes con más cuota (25 MB en servidores con boost y 50 MB para usuarios Premium), van a Supabase Storage. `messaging` valida el tipo de archivo por su contenido y no por la extensión, y limita a 5 adjuntos por mensaje y 20 pendientes por usuario.

## Alternativas descartadas

- **Seguir guardando los archivos en la misma VM donde corre cada servicio.** Es lo que hacíamos, y lo analizamos de nuevo, pero los archivos ocuparían mucho espacio en máquinas que ya tienen poco, además de los problemas de ciclo de vida y de escalado que describe el contexto.
- **Compartir las carpetas de las VMs con NFS o EFS.** Agrega complejidad operativa y no resuelve los respaldos ni el servido de los archivos.
- **Guardar los archivos como bytes dentro de Postgres.** Infla la base, perjudica el rendimiento y vuelve más pesados los respaldos.
- **Un servicio de objetos del estilo de S3 aparte de Supabase.** Es válido, pero ya usamos Supabase para las bases de Postgres y sumar otro proveedor duplica la gestión de cuentas y credenciales.
- **Todo en Supabase Storage, también los adjuntos chicos.** Habría un solo proveedor, pero el espacio gratuito de Supabase es limitado y lo ocuparían los adjuntos, que son lo que más crece.
- **Todo en Cloudinary.** Sirve bien para imágenes, pero su plan gratuito limita cada archivo a 10 MB, así que no cubre los adjuntos grandes de Premium.

## Consecuencias

Los archivos son independientes del ciclo de vida de las VMs, lo que facilita los despliegues y la recuperación ante fallos, y varias instancias de un servicio comparten el mismo almacenamiento sin configurar nada. Además se elimina la necesidad de exponer carpetas o de mantener endpoints propios para servir archivos.

A cambio, dependemos de dos proveedores externos, Supabase y Cloudinary, con su disponibilidad y los límites de sus planes gratuitos, y la lectura y escritura de archivos sufre la latencia de la red en lugar de la del disco local. Los adjuntos quedan repartidos en dos lugares según su tamaño, lo que hace más difícil limpiarlos y respaldarlos de manera uniforme, y para eso `messaging` tiene un limpiador de adjuntos huérfanos. Las URLs de los archivos son públicas, de modo que un adjunto no es privado para quien tenga el enlace. Por último, al pasar de las carpetas de las VMs a los buckets hubo que migrar los archivos que ya existían y actualizar sus referencias en la base.
