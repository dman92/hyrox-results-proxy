# hyrox-results-proxy

Proxy de importación de resultados HYROX para **Hybrid Race Calculator** (iOS).

Un atleta busca su apellido, elige sus carreras y la app importa los splits reales
a una `Simulation` y a sus PR por estación.

## Endpoints

`/` sirve una página para probar la API desde el navegador (buscar atletas, ver
carreras y clasificaciones, abrir splits y ver el JSON crudo).

### `GET /api/search`

Con base de datos (`DATABASE_URL`) busca primero en los listados volcados: responde
al instante, acepta nombre y apellidos en cualquier orden y sin acentos (`q=ana per`),
busca en todas las divisiones si no pasas `division`, y encuentra también al segundo
miembro de un equipo de dobles. Si ahí no hay nada, consulta en vivo como antes. La
respuesta indica `source: "db"` o `"live"`.

| Parámetro | Req. | Descripción |
|---|---|---|
| `q` / `surname` | sí | Nombre y/o apellido (mínimo 2 caracteres) |
| `division` | no | `open` (def.), `pro`, `doubles`, `pro_doubles`, `relay` |
| `eventId` | * | Obligatorio en `doubles`, `pro_doubles` y `relay` |
| `sex` | no | `M` / `W` |
| `ageClass` | no | p. ej. `30-34` |
| `limit` | no | Máx. 100 (def. 50) |

```
/api/search?surname=Dearden&division=pro&sex=M
→ { count: 19, hits: [ { idp, rank, name, nationality, city, year, totalTime, totalSec } ] }
```

**Por persona.** En dobles y relevos cada fila es el equipo ("David Manso, Lucía Pérez"),
así que una búsqueda solo cuenta si todas sus palabras encajan en **la misma persona**
(con "david manso" no sale "Karim Mansouri, David Martin"). La respuesta de la base de
datos trae `athletes`: una entrada por persona con sus carreras, cada una con `as` (cómo
aparece en esa carrera) y `partners` (compañeros). Se agrupa por nombre exacto (sin
acentos ni mayúsculas, en cualquier orden), y una forma corta se une a una más larga
solo si es inequívoco: "David Manso" se une a "David Manso Garcia" si es la única forma
más larga que la contiene; si cabe en dos ("Lucia Perez" en "Lucía Pérez García" y en
"Lucia Perez Lopez") queda aparte. Sin ID de atleta en la web, dos homónimos exactos
salen juntos.

```
/api/search?q=david%20manso
→ { source: "db", hits: [...], athletes: [ { key, name: "David Manso Garcia",
      variants: ["David Manso Garcia", "David Manso"], count: 3,
      results: [ { ...hit, as: "David Manso", partners: ["Lucía Pérez"] } ] } ] }
```

Los hits de la base de datos traen además `event` (código completo del evento, p. ej.
`HPRO_LR3MS4JIAA2`), `eventLabel` y `season`. Para pedir el detalle basta con
`/api/athlete?idp=…&event=…&season=…`. `division` y `eventId` pueden venir `null`
cuando el prefijo del evento no es una división conocida (HD1, HA, HY3…).
`sex` y `ageClass` solo se aplican a la búsqueda en vivo.

### `GET /api/events`

Solo con base de datos: son los eventos que ha descubierto la ingesta.

- Sin parámetros: temporadas disponibles, con número de carreras y resultados.
- `?season=season-9`: carreras de esa temporada agrupadas por sede, en el orden del
  desplegable de la web (de la más reciente a la más antigua; no hay fechas). La sede
  sale del `<optgroup>` de ese desplegable ("2026 Stockholm"); cada sede tiene un
  evento por división y día ("HYROX DOUBLES - Saturday"), que no siempre comparten
  código. Sin sede conocida se agrupa por la parte común del código.

```
/api/events?season=season-8
→ { season, count, races: [ { id, season, name: "2026 Stockholm", place, status, results,
      divisions: [ { code, division, prefix, label: "HYROX DOUBLES - Saturday", results, status } ] } ] }
```

`status`: `available` (con resultados), `upcoming` (publicada, aún sin resultados) o
`pending` (todavía no descargada). Los hits de búsqueda y clasificación traen `place`.

### `GET /api/event`

| Parámetro | Req. | Descripción |
|---|---|---|
| `code` | sí | Código completo del evento (`divisions[].code` de `/api/events`) |
| `q` | no | Filtra la clasificación por nombre |
| `limit` / `offset` | no | Paginación (máx. 200, def. 50) |

```
/api/event?code=HPRO_LR3MS4JIAA2&limit=50&offset=0
→ { event, total, limit, offset, results: [ …mismo formato que los hits de /api/search… ] }
```

Cada resultado se abre con `/api/athlete` igual que un hit de la búsqueda.

### `GET /api/health`

Sin parámetros. Devuelve el commit y el mensaje del build desplegado, para saber
qué versión está sirviendo sin tener que inferirlo del comportamiento.

### `GET /api/athlete`

| Parámetro | Req. | Descripción |
|---|---|---|
| `idp` | sí | Identificador devuelto por `/api/search` |
| `event` | * | Código completo del evento: **devuélvelo si el hit lo trae** (hits de base de datos) |
| `division` | no | Debe coincidir con la de la búsqueda |
| `eventId` | * | **Devuelve el `eventId` que traiga el hit**, si no es `null` |
| `season` | * | **Devuelve la `season` que traiga el hit**, si no es `null` |

> Cada hit de `/api/search` incluye `eventId` y `season`. Si no son `null`, hay
> que pasarlos de vuelta aquí: un `idp` de una lista por evento no resuelve
> contra la URL de detalle del ranking all-time, y consultar una carrera de
> `season-8` bajo `season-9` devuelve **200 con la ficha vacía**, no un error.
> Devuélvelos tal cual.

Devuelve cabecera (nombre, nacionalidad, grupo de edad, dorsal, sede, año, bonus,
penalización, motivo de descalificación, puesto por género y por grupo de edad),
`members[]` con **los dos integrantes en dobles** (nombre + nacionalidad) y `splits[]`:
8 runs, 8 estaciones, roxzone, run total y best run lap, cada uno con tiempo,
segundos y **puesto mundial**.

Las páginas de detalle no usan una única plantilla: unas traen `Name` + `Nat` por
separado y otras un solo `Athlete` con la nacionalidad entre paréntesis. El parser
acepta ambas, y un nombre ilegible invalida el resultado en vez de devolver `null`.

## Base de datos (Neon) e ingesta

Buscar en vivo es lento: cada consulta en frío hace que results.hyrox.com tarde
~30 s o devuelva 504. Por eso los listados se vuelcan a Postgres (Neon) y la API
busca ahí. Los splits no se vuelcan (serían ~1 petición por resultado): se piden
en vivo la primera vez que alguien abre una carrera y se guardan en `details`.

- **Tablas** (`lib/db.ts`): `events` (checkpoint por evento), `results` (una fila
  por resultado, con índice trigram para buscar por nombre) y `details` (caché de
  `/api/athlete`). Se crean solas en la primera ingesta.
- **Espacio**: ~300 MB por millón de resultados. Las temporadas 7-9 caben en los
  0,5 GB del plan gratuito; cuando no quepan, borra la más antigua:
  `DELETE FROM results WHERE season = 'season-7'; DELETE FROM events WHERE season = 'season-7';`
- **Ingesta automática**: `.github/workflows/ingest.yml` se ejecuta cada 6 h con el
  secret `DATABASE_URL`. Cada ejecución trabaja como mucho ~4,5 h y la siguiente
  sigue donde lo dejó; con todo volcado, tarda 1-2 min (carreras nuevas + refresco
  de las recientes durante 10 días). También se lanza a mano desde Actions →
  Ingesta HYROX → Run workflow (con `max_events: 2` para probar).
- **Ingesta local**: `DATABASE_URL=… npm run ingest -- --season 8`. Sin
  `DATABASE_URL` escribe `data/<season>.jsonl` como antes.

Sin `DATABASE_URL` todo funciona como antes, en vivo.

## Decisiones de diseño

**Base de datos opcional.** Un resultado pasado no cambia nunca, así que `/api/athlete`
va con `s-maxage=31536000, immutable` y lo absorbe el CDN de Vercel, y además se
guarda en `details`. `/api/search` usa una hora, porque sí aparecen carreras nuevas.
Si la base de datos falla, la API sigue en vivo en vez de devolver error.

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
  registra quién hizo qué dentro de cada estación. Sí devuelve `members[]` con el
  nombre y la nacionalidad de cada integrante.
- **El buscador de mika solo indexa al primer miembro del equipo.** Comprobado:
  en el equipo `Brent Lee, Ritzy Amor Ectin`, buscar "Ectin" devuelve 0 filas y
  "Lee" devuelve 13. Quien corriera como segundo no se encuentra por su propio
  apellido, ni aquí ni en la web oficial. Afecta a la mitad de los dobles.
- En la plantilla por evento **la sede no aparece en la página**: `city` y `year`
  salen `null`. El cliente debe usar el evento que ya eligió.
- Hay **dos plantillas de detalle** distintas. La de evento nombra la sede como
  `Race: "2026 Bangkok"` (año delante), deja el total fuera de la tabla de splits
  y añade una tabla de paso por roxzone con horas de reloj que hay que ignorar.
- **La primera petición de una consulta en frío tarda ~25-30s, o devuelve un 504
  del propio results.hyrox.com**; las siguientes, ~0,3s (su `x-results-cache`).
  Por eso se hacen dos intentos de 28s en vez de uno largo: el primero calienta
  su caché aunque falle. Si los dos fallan, la respuesta es `504` con
  `retryable: true` y `Retry-After`, y el cliente debe reintentar.

## Desarrollo

```bash
npm install
npm test           # parser contra fixtures HTML reales
TEST_DATABASE_URL=postgres://localhost/hyrox_test npm test   # + ingesta y búsqueda contra Postgres
npm run typecheck
```

Los fixtures de `test/fixtures/` están fuera de git (`.gitignore`): son HTML ajeno.
Para regenerarlos, descarga una página de búsqueda y dos de detalle (individual y dobles).
