# hyrox-results-proxy

Proxy de importación de resultados HYROX para **Hybrid Race Calculator** (iOS).

Un atleta busca su apellido, elige sus carreras y la app importa los splits reales
a una `Simulation` y a sus PR por estación.

## Endpoints

### `GET /api/search`

| Parámetro | Req. | Descripción |
|---|---|---|
| `surname` | sí | Apellido (mínimo 2 caracteres) |
| `division` | no | `open` (def.), `pro`, `doubles`, `pro_doubles`, `relay` |
| `eventId` | * | Obligatorio en `doubles`, `pro_doubles` y `relay` |
| `sex` | no | `M` / `W` |
| `ageClass` | no | p. ej. `30-34` |
| `limit` | no | Máx. 100 (def. 50) |

```
/api/search?surname=Dearden&division=pro&sex=M
→ { count: 19, hits: [ { idp, rank, name, nationality, city, year, totalTime, totalSec } ] }
```

### `GET /api/health`

Sin parámetros. Devuelve el commit y el mensaje del build desplegado, para saber
qué versión está sirviendo sin tener que inferirlo del comportamiento.

### `GET /api/athlete`

| Parámetro | Req. | Descripción |
|---|---|---|
| `idp` | sí | Identificador devuelto por `/api/search` |
| `division` | no | Debe coincidir con la de la búsqueda |

Devuelve cabecera (nombre, nacionalidad, grupo de edad, dorsal, sede, año, bonus,
penalización, motivo de descalificación, puesto por género y por grupo de edad),
`members[]` con **los dos integrantes en dobles** (nombre + nacionalidad) y `splits[]`:
8 runs, 8 estaciones, roxzone, run total y best run lap, cada uno con tiempo,
segundos y **puesto mundial**.

Las páginas de detalle no usan una única plantilla: unas traen `Name` + `Nat` por
separado y otras un solo `Athlete` con la nacionalidad entre paréntesis. El parser
acepta ambas, y un nombre ilegible invalida el resultado en vez de devolver `null`.

## Decisiones de diseño

**Sin base de datos.** Un resultado pasado no cambia nunca, así que `/api/athlete`
va con `s-maxage=31536000, immutable` y lo absorbe el CDN de Vercel. `/api/search`
usa una hora, porque sí aparecen carreras nuevas. Si algún día hace falta analítica
o modo offline, se añade Postgres; para importar, no hace falta.

**Falla ruidosamente.** `parseDetail` valida que haya ≥18 splits y que la suma de los
8 runs cuadre con `Run Total` (±10s, que es la deriva del redondeo al segundo de mika).
Si no cuadra, `/api/athlete` devuelve `502 parse_failed` en vez de datos a medias:
mejor un error visible que importar basura silenciosamente.

**Fuente intercambiable.** Toda la dependencia de `results.hyrox.com` vive en
`lib/hyrox.ts`. La app consume estos dos endpoints, no el HTML. Cambiar a una API de
pago (p. ej. hyroxresultapi.com) es reescribir ese fichero, sin tocar la app.

## Limitaciones conocidas

- **`results.hyrox.com` devuelve 403 a User-Agents no-navegador.** Comprobado: UA
  propio → 403, vacío → 403, con "Bot" → 403. El sitio filtra clientes automatizados
  a propósito. Ver el comentario en `lib/hyrox.ts`.
- **En dobles y relevos no se puede buscar por apellido a nivel global**: el ranking
  all-time ignora `search[name]`. Hay que acotar por `eventId`, así que la UI tiene
  que pedir sede y día. En individual no hace falta.
- **En dobles los splits son del equipo**, no por integrante. results.hyrox.com no
  registra quién hizo qué dentro de cada estación.
- **La primera petición de una consulta en frío tarda ~25-30s**; las siguientes,
  ~0,3s (su propio `x-results-cache`). De ahí los 45s de timeout y `maxDuration: 60`.
  Si aun así expira, la respuesta es `504` con `retryable: true` y `Retry-After`:
  el cliente debe reintentar, porque esa primera petición ya calentó su caché.

## Desarrollo

```bash
npm install
npm test           # parser contra fixtures HTML reales
npm run typecheck
```

Los fixtures de `test/fixtures/` están fuera de git (`.gitignore`): son HTML ajeno.
Para regenerarlos, descarga una página de búsqueda y dos de detalle (individual y dobles).
