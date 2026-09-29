/**
 * Página de pruebas de la API (GET /). Sin dependencias ni build: HTML + JS inline.
 * Vive en una función y no como estático para no depender de la configuración de
 * salida del proyecto en Vercel.
 */
export const UI_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HYROX API · pruebas</title>
<style>
  :root {
    --bg: #f6f6f4; --card: #fff; --text: #1c1c1a; --muted: #6b6b66; --line: #e3e3de;
    --accent: #d4a300; --accent-text: #1c1c1a; --ok: #1f7a3a; --warn: #9a5b00; --err: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121211; --card: #1c1c1a; --text: #ecece8; --muted: #9a9a94; --line: #2e2e2b;
      --accent: #ffd23f; --ok: #5cc27d; --warn: #e0a24a; --err: #f07167;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 20px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
  form { display: flex; flex-wrap: wrap; gap: 8px; }
  input, select, button { font: inherit; padding: 9px 11px; border-radius: 8px;
         border: 1px solid var(--line); background: var(--card); color: var(--text); }
  input[name=q] { flex: 1 1 220px; }
  input[name=eventId] { flex: 0 1 150px; }
  button { background: var(--accent); color: var(--accent-text); border: 0; font-weight: 600; cursor: pointer; }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); font-weight: 400; }
  .status { margin: 14px 0 8px; font-size: 13px; color: var(--muted); min-height: 1.4em; word-break: break-all; }
  .status.err { color: var(--err); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 12px; font-weight: 600;
           border: 1px solid currentColor; margin-right: 6px; }
  .db { color: var(--ok); } .live { color: var(--warn); }
  .list { display: grid; gap: 6px; }
  .hit { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 10px 12px; text-align: left;
         background: var(--card); border: 1px solid var(--line); border-radius: 10px; cursor: pointer;
         color: var(--text); font-weight: 400; width: 100%; }
  .hit:hover { border-color: var(--accent); }
  .hit b { font-weight: 600; }
  .hit .t { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
  .hit small { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-top: 12px; }
  .card h2 { margin: 0 0 4px; font-size: 18px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 18px; margin: 8px 0 14px; }
  .kpis div { font-size: 12px; color: var(--muted); }
  .kpis b { display: block; font-size: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  td, th { padding: 6px 4px; border-bottom: 1px solid var(--line); text-align: left; font-size: 14px; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.n, th.n { text-align: right; }
  tr.run td:first-child { color: var(--muted); }
  .bar { height: 6px; border-radius: 3px; background: var(--accent); opacity: .8; }
  details { margin-top: 12px; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  pre { overflow: auto; font-size: 12px; background: var(--bg); padding: 10px; border-radius: 8px; max-height: 420px; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
</style>
</head>
<body>
<main>
  <h1>HYROX <span>API</span> · pruebas</h1>
  <p class="sub">Busca un atleta y pulsa un resultado para ver sus splits. Verde = base de datos, naranja = en vivo.</p>

  <form id="f">
    <input name="q" placeholder="Nombre y/o apellido" autocomplete="off" required minlength="2">
    <select name="division">
      <option value="">Todas las divisiones</option>
      <option value="open">Open</option>
      <option value="pro">Pro</option>
      <option value="doubles">Doubles</option>
      <option value="pro_doubles">Pro doubles</option>
      <option value="relay">Relay</option>
    </select>
    <input name="eventId" placeholder="eventId (opcional)" autocomplete="off">
    <button>Buscar</button>
    <button type="button" class="ghost" id="health">/api/health</button>
  </form>

  <div class="status" id="status"></div>
  <div class="list" id="list"></div>
  <div id="detail"></div>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var hits = [];

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(sec) {
    if (sec == null) return '–';
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.round(sec % 60);
    var mm = (h ? String(m).padStart(2, '0') : m), ss = String(s).padStart(2, '0');
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function status(html, isErr) { var el = $('status'); el.innerHTML = html; el.className = 'status' + (isErr ? ' err' : ''); }

  // results.hyrox.com a veces da 504 en frío; la API lo marca como reintentable.
  function call(url, attempt) {
    attempt = attempt || 1;
    var t0 = performance.now();
    return fetch(url).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        var ms = Math.round(performance.now() - t0);
        if (r.status === 504 && body.retryable && attempt < 3) {
          status('504 en frío (' + ms + ' ms), reintentando ' + (attempt + 1) + '/3… ' + esc(url));
          return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () { return call(url, attempt + 1); });
        }
        return { ok: r.ok, code: r.status, body: body, ms: ms, url: url };
      });
    });
  }

  function raw(obj) { return '<details><summary>JSON</summary><pre>' + esc(JSON.stringify(obj, null, 2)) + '</pre></details>'; }

  $('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(e.target), p = new URLSearchParams();
    p.set('q', fd.get('q').trim());
    if (fd.get('division')) p.set('division', fd.get('division'));
    if (fd.get('eventId').trim()) p.set('eventId', fd.get('eventId').trim());
    var url = '/api/search?' + p;
    $('list').innerHTML = ''; $('detail').innerHTML = '';
    status('Buscando… ' + esc(url));
    call(url).then(function (res) {
      if (!res.ok) { status(res.code + ' · ' + res.ms + ' ms · ' + esc(res.body.error || '') + ' ' + esc(res.body.hint || res.body.detail || ''), true); return; }
      hits = res.body.hits || [];
      var src = res.body.source || 'live';
      status('<span class="badge ' + src + '">' + src + '</span>' + hits.length + ' resultados · ' + res.ms + ' ms · ' + esc(url));
      $('list').innerHTML = hits.map(function (h, i) {
        var where = h.eventLabel || [h.city, h.year].filter(Boolean).join(' ') || '';
        var extra = [h.division || h.event, h.season, h.ageGroup, h.nationality].filter(Boolean).join(' · ');
        return '<button class="hit" data-i="' + i + '">' +
          '<b>' + esc(h.name) + '</b><span class="t">' + esc(h.totalTime || '–') + '</span>' +
          '<small>' + esc(where) + (h.rank ? ' · #' + h.rank : '') + '</small><small>' + esc(extra) + '</small></button>';
      }).join('') + (hits.length ? '' : '<p class="sub">Sin resultados.</p>') + raw(res.body);
    }).catch(function (err) { status('Error de red: ' + esc(err.message), true); });
  });

  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('.hit'); if (!b) return;
    var h = hits[+b.dataset.i], p = new URLSearchParams({ idp: h.idp });
    if (h.event) p.set('event', h.event);
    else { if (h.division) p.set('division', h.division); if (h.eventId) p.set('eventId', h.eventId); }
    if (h.season) p.set('season', h.season);
    var url = '/api/athlete?' + p;
    $('detail').innerHTML = '';
    status('Cargando splits… (la primera vez puede tardar ~30 s) ' + esc(url));
    call(url).then(function (res) {
      if (!res.ok) {
        status(res.code + ' · ' + res.ms + ' ms · ' + esc(res.body.error || '') + ' ' + esc(res.body.detail || ''), true);
        $('detail').innerHTML = '<div class="card">' + raw(res.body) + '</div>';
        return;
      }
      status(res.code + ' · ' + res.ms + ' ms · ' + esc(url));
      renderDetail(res.body, h);
      $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (err) { status('Error de red: ' + esc(err.message), true); });
  });

  function renderDetail(d, hit) {
    var splits = d.splits || [];
    var byKey = {}; splits.forEach(function (s) { byKey[s.key] = s; });
    var total = byKey.total ? byKey.total.seconds : hit.totalSec;
    var runs = splits.filter(function (s) { return /^run_\d+$/.test(s.key); });
    var stations = splits.filter(function (s) {
      return ['ski_erg','sled_push','sled_pull','burpee_broad_jump','row_erg','farmers_carry','sandbag_lunges','wall_balls'].indexOf(s.key) >= 0;
    });
    var sum = function (a) { return a.reduce(function (t, s) { return t + s.seconds; }, 0); };
    // Orden de carrera: Run 1, estación 1, Run 2, estación 2...
    var order = [];
    for (var i = 0; i < Math.max(runs.length, stations.length); i++) {
      if (runs[i]) order.push(runs[i]); if (stations[i]) order.push(stations[i]);
    }
    ['roxzone', 'run_total', 'best_run_lap'].forEach(function (k) { if (byKey[k]) order.push(byKey[k]); });
    var max = Math.max.apply(null, order.map(function (s) { return s.key === 'run_total' ? 0 : s.seconds; }).concat([1]));

    var who = d.members && d.members.length
      ? d.members.map(function (m) { return esc(m.name) + (m.nationality ? ' (' + esc(m.nationality) + ')' : ''); }).join(' · ')
      : esc(d.nationality || '');
    var place = [d.city, d.year].filter(Boolean).join(' ') || hit.eventLabel || '';
    $('detail').innerHTML = '<div class="card">' +
      '<div class="row"><h2>' + esc(d.name || hit.name) + '</h2></div>' +
      '<div class="meta">' + [esc(place), esc(d.divisionLabel || hit.division || ''), esc(d.ageGroup || ''), who].filter(Boolean).join(' · ') + '</div>' +
      '<div class="kpis">' +
        '<div>Total<b>' + fmt(total) + '</b></div>' +
        '<div>Runs<b>' + fmt(runs.length ? sum(runs) : null) + '</b></div>' +
        '<div>Estaciones<b>' + fmt(stations.length ? sum(stations) : null) + '</b></div>' +
        '<div>Roxzone<b>' + fmt(byKey.roxzone ? byKey.roxzone.seconds : null) + '</b></div>' +
        '<div>Puesto (M/W)<b>' + (d.rankGender || '–') + '</b></div>' +
        '<div>Puesto (AG)<b>' + (d.rankAgeGroup || '–') + '</b></div>' +
      '</div>' +
      (d.penalty || d.disqualReason ? '<p class="status err">' + esc([d.penalty && 'Penalización: ' + d.penalty, d.disqualReason].filter(Boolean).join(' · ')) + '</p>' : '') +
      '<table><thead><tr><th>Tramo</th><th class="n">Tiempo</th><th class="n">Puesto</th><th style="width:35%"></th></tr></thead><tbody>' +
      order.map(function (s) {
        var isRun = /^run_/.test(s.key);
        var w = s.key === 'run_total' ? 0 : Math.round(s.seconds / max * 100);
        return '<tr class="' + (isRun ? 'run' : '') + '"><td>' + esc(s.label) + '</td><td class="n">' + esc(s.time) +
          '</td><td class="n">' + (s.place || '') + '</td><td>' + (w ? '<div class="bar" style="width:' + w + '%"></div>' : '') + '</td></tr>';
      }).join('') +
      '</tbody></table>' +
      '<p class="sub" style="margin-top:10px">' + splits.length + ' splits · validación ' +
        (d.validation && d.validation.ok ? 'OK' : 'con avisos') + '</p>' +
      raw(d) + '</div>';
  }

  $('health').addEventListener('click', function () {
    status('Consultando /api/health…');
    call('/api/health').then(function (res) {
      status(res.code + ' · ' + res.ms + ' ms · commit ' + esc(res.body.commit || '?') + ' · ' + esc(res.body.message || ''), !res.ok);
      $('list').innerHTML = raw(res.body); $('detail').innerHTML = '';
    });
  });

  // ?q=... en la URL lanza la búsqueda directamente (útil para compartir un enlace)
  var q = new URLSearchParams(location.search).get('q');
  if (q) { document.querySelector('[name=q]').value = q; $('f').requestSubmit(); }
})();
</script>
</body>
</html>`;
