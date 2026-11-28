'use strict';
// clone-history.js — el historial que un clon liviano (`--filter=blob:none`) deja bajado mientras el paso que clona
// todavía tiene la credencial. Un clon liviano baja el contenido a pedido; el paso que lo lee después (las métricas de
// la noche leen cada versión vieja de cada historia) no tiene la credencial, y en un repo privado ese pedido sale sin
// ella: todo quedaría «no medido». Por eso el conector, al clonar, baja de una vez el contenido de cada versión de los
// archivos que el núcleo nombra en `history` (pathspecs de git), con la misma consulta que usan las métricas.
//
// `git` es la función con la que corre git el conector, con la credencial en su entorno (nunca en los argumentos ni en
// la config del clon): `(args) => { status, stdout, stderr }`. No lanza: devuelve `{ ok, total, faltan, detail }`. Un
// historial que no se bajó entero no corta el clon: las métricas cuentan lo que falta como «no medido».

const LOTE = 500;                        // el lote de las métricas (scripts/metrics/sdlc-stage-metrics.js)
const TOPE_MS = 5 * 60 * 1000;

/** Los blobs de cada versión de los archivos de `pathspecs` en el historial (los que leen las métricas). */
function oidsDelHistorial(git, dir, pathspecs) {
  const r = git(['-C', dir, '-c', 'core.quotepath=false', 'log', '--format=', '--raw', '--no-abbrev', '--no-renames',
    '--diff-merges=first-parent', '--', ...pathspecs]);
  if (r.status !== 0) return null;
  const oids = new Set();
  for (const l of String(r.stdout || '').split('\n')) {
    const m = l.match(/^:\S+ \S+ \S+ ([0-9a-f]+) /);
    if (m && !/^0+$/.test(m[1])) oids.add(m[1]);
  }
  return [...oids];
}

function bajarHistorial(git, dir, pathspecs, { lote = LOTE, topeMs = TOPE_MS, ahora = Date.now } = {}) {
  const oids = oidsDelHistorial(git, dir, pathspecs);
  if (oids === null) return { ok: false, total: 0, faltan: null, detail: 'no pude leer el historial del clon' };
  const t0 = ahora();
  let faltan = 0;
  for (let i = 0; i < oids.length; i += lote) {
    if (ahora() - t0 > topeMs) { faltan += oids.length - i; break; }
    const chunk = oids.slice(i, i + lote);
    const f = git(['-C', dir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', ...chunk]);
    if (f.status !== 0) faltan += chunk.length;
  }
  return faltan
    ? { ok: false, total: oids.length, faltan, detail: `${faltan} de ${oids.length} versiones del historial sin bajar: las métricas las cuentan como no medidas` }
    : { ok: true, total: oids.length, faltan: 0, detail: null };
}

module.exports = { bajarHistorial, oidsDelHistorial };
