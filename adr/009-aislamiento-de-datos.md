# ADR-009: Aislamiento de datos entre servicios en Postgres/Supabase

**Estado:** Confirmado  
**Fecha:** 12/09/2026

## Contexto

Hasta ahora, los archivos que generan o reciben los servicios (por ejemplo, avatares de usuarios e imágenes de servidores) se guardaban en carpetas dentro del sistema de archivos de las VMs donde corre cada servicio. Esto trae varios problemas:

- Acoplamiento al ciclo de vida de la VM: si la VM se recrea, se migra o falla el disco, los archivos se pierden o hay que migrarlos a mano.
- Escalado horizontal limitado: varias instancias de un mismo servicio no comparten el mismo filesystem, por lo que los archivos quedan en una sola máquina.
- Aislamiento débil entre servicios: las carpetas comparten el mismo host, y la separación depende de convenciones de rutas y permisos del sistema operativo, no de una política explícita.
- Gestión de accesos manual: servir los archivos requiere exponerlos desde la VM o programar endpoints propios, sin un control de acceso centralizado.
- Backups y observabilidad dispersos: cada VM requiere su propia estrategia de respaldo.

## Decisión

Dejamos de almacenar archivos en carpetas dentro de las VMs y pasamos a usar buckets de Supabase Storage como almacenamiento único de archivos.

Puntos concretos:

- Un bucket por dominio de datos o servicio, en lugar de carpetas en disco. Ejemplos:
- avatars: avatares de usuarios.
- server-images: imágenes de los servidores.
- Aislamiento mediante políticas RLS (Row Level Security) sobre storage.objects, de modo que cada servicio y cada usuario solo acceda a lo que le corresponde.
- Convención de rutas dentro del bucket por identificador de propietario (por ejemplo {user_id}/avatar.png o {server_id}/icon.png), de forma que las políticas puedan validar la pertenencia a partir de la ruta.
- Los servicios guardan en la base de datos solo la referencia (ruta o URL) al objeto, no el archivo en sí.
- Las VMs pasan a ser stateless respecto a archivos de usuario: no se escribe contenido persistente en el disco local.
- Acceso según sensibilidad: buckets públicos para contenido no sensible que se sirve por CDN (avatares, imágenes de servidores) y buckets privados con URLs firmadas para lo que requiera control de acceso.

## Consecuencias

**Positivas**

- Los archivos son independientes del ciclo de vida de las VMs, lo que facilita despliegues, migraciones y recuperación ante fallos.
- Varias instancias de un servicio comparten el mismo almacenamiento sin configuración adicional.
- El aislamiento entre servicios se define de forma declarativa con políticas RLS, y es auditable y consistente con el resto del modelo de datos.
- Backups, CDN y transformaciones de imagen quedan centralizados en Supabase.
- Se elimina la necesidad de exponer carpetas de las VMs o mantener endpoints propios para servir archivos.

**Negativas / costos**

- Dependencia adicional de Supabase Storage (vendor lock-in y disponibilidad).
- Necesitamos definir y mantener correctamente las políticas RLS: un error de configuración puede exponer o bloquear datos.
- Latencia de red al leer y escribir archivos en lugar de disco local.
- Hay que migrar los archivos existentes de las carpetas de las VMs a los buckets y actualizar las referencias en la base de datos.
- Costos de almacenamiento y transferencia según el plan de Supabase.

## Alternativas consideradas

- Mantener carpetas en las VMs con volúmenes compartidos (NFS/EFS): agrega complejidad operativa y no resuelve el aislamiento por política.
- Guardar los archivos como byte en Postgres: infla la base de datos y perjudica el rendimiento y los backups.
- Otro object storage (S3 u similar) fuera de Supabase: válido, pero duplica la gestión de accesos y autenticación que ya tenemos integrada con Supabase.

## Plan de migración

- Crear los buckets y las políticas RLS.
- Adaptar los servicios para escribir y leer desde Storage.
- Migrar los archivos existentes y actualizar las referencias en la base de datos.
- Eliminar el almacenamiento en carpetas de las VMs una vez validado
