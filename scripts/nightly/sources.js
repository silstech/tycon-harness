#!/usr/bin/env node
'use strict';
// sources.js — el paso común de la noche que trae los repos de las fuentes que declara operations.json
// (`nightly.sources`): a cada fuente le pide, por la capa de plataforma (scripts/lib/platform/platform.js), la lista de
// sus repos y el clon de cada uno. No nombra ninguna plataforma: la que atiende cada fuente la decide la capa.
//
// Uso:
//   node sources.js declared --operations <operations.json>
//       sale 0 si el archivo declara fuentes válidas; 1 si no declara ninguna, o si la sección tiene problemas (lo dice
//       con un ::warning::: la noche sigue con lo de hoy).
//   node sources.js clone --dir <carpeta> --operations <operations.json> [--team-repos <archivo>] [--repos-json <archivo>]
//                         [--dashboard <carpeta>] [--today AAAA-MM-DD]
//       clona liviano (Markdown, .advisors/ y .tycon/: los patrones los pone este paso, no el conector) los repos de cada
//       fuente en <carpeta>, con un nombre de carpeta sin choques, y deja <carpeta>/sources-index.json (carpeta → fuente,
//       con el grupo de sus hermanos) y <dashboard>/nightly-sources-<día>.json (el estado de cada fuente).
//   node sources.js clone-declared <carpeta>
//       la revisión de dependencias: lee de la entrada `<ruta>\t<JSON de la fuente con su repo>` (lo que imprime
//       `nightly-dependencies.js clone-list --sources`) y clona cada repo completo, con profundidad 1, en <carpeta>/<ruta>.
//   node sources.js skipped --operations <operations.json> [--format vso|actions]
//       una noche que todavía no lee fuentes avisa, nombrando cada una, que esa noche no la mide.
//
// La credencial de cada plataforma sale del secreto HARNESS_SOURCE_CREDENTIALS (un JSON { "<plataforma>": "<token>" }):
// cada entrada se enmascara en la salida del paso apenas se lee (un JSON mal escrito da un error que no muestra su texto),
// y cada conector recibe sólo la suya.
//
// El estado de una fuente: `medida`, `en_parte` (un repo declarado que la fuente no devolvió, o uno que no se clonó: los
// demás se miden) o `no_medida`, con el motivo del contrato. Cero repos en una fuente declarada es un aviso, nunca un
// verde mudo. Sale 0 (lo que falló va como ::warning::) · 1 la configuración no se lee · 2 error de uso.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OC = require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));
const TR = require(path.join(ROOT, 'scripts', 'lib', 'team-repos.js'));
const P = require(path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js'));

// la forma de cada fuente, para el lector de operations.json (que viaja solo y no la carga): la del repo de su
// plataforma, con un nombre de repo de relleno, según el lector de team-repos.js
OC.useSourceValidator((s, at) => TR.repoProblems({ ...s, repo: 'x' }, at, { platforms: TR.PLATFORMS }));

// lo que baja el clon liviano: lo que leen las métricas de la noche
const LIGHT_PATTERNS = Object.freeze(['**/*.md', '.advisors/**', '.tycon/**']);
const CREDS_VAR = 'HARNESS_SOURCE_CREDENTIALS';
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Las credenciales del secreto: `{ <plataforma>: <token> }`. Escribe un `::add-mask::` por entrada en la salida del paso
 * apenas lo lee. Un JSON mal escrito es un error que no muestra su texto (y no se usa ninguna entrada).
 */
function readCredentials(raw, out = (l) => process.stdout.write(`${l}\n`)) {
  if (raw === undefined || raw === null || !String(raw).trim()) return {};
  let v;
  try { v = JSON.parse(String(raw)); } catch (_) {
    out(`::error::${CREDS_VAR} no es un JSON { "plataforma": "token" } válido: no se usa ninguna entrada (su texto no se muestra)`);
    return {};
  }
  if (!isObject(v)) { out(`::error::${CREDS_VAR} no es un objeto { "plataforma": "token" }: no se usa`); return {}; }
  const creds = {};
  for (const [k, t] of Object.entries(v)) {
    if (typeof t === 'string' && t.trim()) { out(`::add-mask::${t}`); creds[k] = t; }
    else out(`::warning::${CREDS_VAR}: la entrada «${k}» no es un token (un texto): no se usa`);
  }
  return creds;
}

/** Las claves de la fuente (el dueño o el grupo) según la forma de repo de su conector: todas menos `repo`. */
function groupKeys(platform) {
  const forma = TR.repoShape(platform);
  return forma ? forma.keys.slice(0, -1) : null;
}

/** El nombre de una fuente en los avisos y en el tablero: `<plataforma>:[<servidor>/]<dueño o grupo>`. */
function labelOf(s) {
  const keys = groupKeys(s.platform) || Object.keys(s).filter((k) => k !== 'platform' && k !== 'host').sort();
  return `${s.platform}:${s.host ? `${s.host}/` : ''}${keys.map((k) => s[k]).join('/')}`;
}

/** El id de un repo declarado con su forma completa (`{ platform, …, repo }`), como lo da la lista de su fuente. */
function idOf(entry) {
  const forma = TR.repoShape(entry.platform);
  return forma ? forma.keys.map((k) => entry[k]).join('/') : null;
}

/** El servidor de una fuente o un repo: el `host` que nombra o, sin él, el de por defecto de su conector. */
function hostKey(s) {
  const forma = TR.repoShape(s.platform);
  return String(s.host || (forma && forma.defaults && forma.defaults.host) || '').toLowerCase();
}
const grupoDeId = (id) => String(id).split('/').slice(0, -1).join('/');

/** El grupo de hermanos de un repo de una fuente: misma plataforma, mismo servidor, mismo dueño o grupo. */
function groupOf(source, id) { return `${source.platform}|${hostKey(source)}|${grupoDeId(id).toLowerCase()}`; }

/**
 * La carpeta de un repo. Los de la plataforma de la propia noche (la del repo de operaciones), de su servidor por
 * defecto y con la forma `<dueño>/<repo>`, conservan `<dueño>__<repo>`; los demás llevan la plataforma, un nombre legible
 * sin `__` y un resumen del id, así dos fuentes con un dueño del mismo nombre no chocan.
 */
function folderFor(source, id, nightPlatform, taken = new Set()) {
  const partes = String(id).split('/');
  let base;
  if (nightPlatform && source.platform === nightPlatform && !source.host && partes.length === 2) base = `${partes[0]}__${partes[1]}`;
  else {
    const legible = `${source.host ? `${source.host}-` : ''}${id}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/_{2,}/g, '_').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
    const resumen = crypto.createHash('sha1').update(`${source.platform}|${hostKey(source)}|${String(id).toLowerCase()}`).digest('hex').slice(0, 8);
    base = `${source.platform}--${legible}--${resumen}`;
  }
  let nombre = base;
  for (let i = 2; taken.has(nombre.toLowerCase()); i++) nombre = `${base}-${i}`;
  taken.add(nombre.toLowerCase());
  return nombre;
}

/** Los repos con forma completa (`platform` y `repo`) que hay adentro de un valor: lo que declara un archivo. */
function reposDentro(v, out = []) {
  if (Array.isArray(v)) { for (const x of v) reposDentro(x, out); return out; }
  if (!isObject(v)) return out;
  if (typeof v.platform === 'string' && typeof v.repo === 'string') { out.push(v); return out; }
  for (const x of Object.values(v)) reposDentro(x, out);
  return out;
}

/**
 * Los repos declarados (en repos.json, la clave `source`; en team-repos.json, los de producto: merge_suites y
 * story_index) que pertenecen a una fuente.
 */
function declaradosDe(source, declarados) {
  const grupo = (groupKeys(source.platform) || []).map((k) => source[k]).join('/').toLowerCase();
  return [...new Set(declarados.filter((d) => d.platform === source.platform && hostKey(d) === hostKey(source)).map(idOf).filter(Boolean)
    .filter((id) => { const g = grupoDeId(id).toLowerCase(); return g === grupo || g.startsWith(`${grupo}/`); }))];
}

function leerJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }

/** El entorno que la capa le pasa a un conector: sin el secreto con las credenciales de todas las plataformas, porque
 * cada conector recibe sólo la suya en `args.credential` y lo que lanza (git, la API) no tiene que ver las demás. */
function connectorEnv(env) {
  const limpio = { ...env };
  delete limpio[CREDS_VAR];
  return limpio;
}

/** Lo que el núcleo le dice a la persona de un «no» de la capa. */
function porque(r) {
  const d = P.limpiar(r.detail || '');
  return r.reason === 'no_soportado' ? `su conector no lista repos (${d}): esta noche no la mide` : d;
}

/** Las fuentes de operations.json: `{ sources }` o `{ problema }` (ya dicho como ::warning::), o `{}` sin fuentes. */
function fuentesDe(ops, out) {
  const r = OC.load(ops);
  if (r.couldNotRead) {
    // sin el archivo no hay fuentes declaradas; con el archivo y sin poder leerlo, la noche no sabe si las hay
    if (fs.existsSync(ops)) out(`::warning::no pude leer operations.json (${r.problems.map((p) => p.message).join('; ')}): la noche no mide las fuentes declaradas y sigue con lo de hoy`);
    return {};
  }
  if (!r.ok) { out(`::warning::operations.json no valida (${r.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join('; ')}): la noche no mide las fuentes declaradas y sigue con lo de hoy`); return { problema: true }; }
  const sp = r.sectionProblems && r.sectionProblems.nightly;
  if (sp) { out(`::warning::operations.json: la sección nightly tiene problemas (${sp.map((p) => `${p.path}: ${p.message}`).join('; ')}): esta noche no mide las fuentes declaradas y sigue con lo de hoy`); return { problema: true }; }
  const sources = r.data && r.data.nightly && Array.isArray(r.data.nightly.sources) ? r.data.nightly.sources : [];
  return sources.length ? { sources } : {};
}

async function clone(o, env, out) {
  const creds = readCredentials(env[CREDS_VAR], out);
  const { sources } = fuentesDe(o.operations, out);
  if (!sources) { out('::error::operations.json no declara fuentes válidas: no se clonó nada'); return 1; }
  if (String(env.OWNERS || '').trim()) out('::warning::nightly.sources de operations.json manda: la variable METRICS_OWNERS se ignora');
  const envConector = connectorEnv(env);
  const team = o.teamRepos && fs.existsSync(o.teamRepos) ? TR.load(o.teamRepos) : null;
  const teamData = team && team.ok ? team.data : null;
  if (o.teamRepos && !teamData) {
    const motivo = team ? team.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join('; ') : 'no está';
    out(`::warning::no pude leer team-repos.json (${motivo}): la noche mide igual, sin saltear las copias del arnés ni cruzar los repos de producto declarados`);
  }
  const nightPlatform = teamData && teamData.operations ? teamData.operations.platform : null;
  const rj = o.reposJson ? leerJson(o.reposJson) : null;
  if (o.reposJson && !rj) out('::warning::no pude leer repos.json: la noche mide igual, sin cruzar los repos declarados que la fuente no devolvió');
  const declarados = [
    // una entrada apagada a propósito (`activo: false`) no se espera de la fuente
    ...((rj && Array.isArray(rj.repos) ? rj.repos : []).filter((r) => r && r.activo !== false).map((r) => r.source).filter((s) => isObject(s) && typeof s.repo === 'string')),
    ...(teamData ? reposDentro([teamData.merge_suites, teamData.story_index]) : []),
  ];
  fs.mkdirSync(o.dest, { recursive: true });
  const index = {};
  const estado = [];
  const taken = new Set();
  // los repos ya traídos, por servidor e id → la fuente que los trajo: dos fuentes que se pisan (un grupo y uno de sus
  // subgrupos) no clonan ni cuentan dos veces el mismo repo
  const traidos = new Map();
  for (const source of sources) {
    const label = labelOf(source);
    const credential = creds[source.platform];
    const e = { fuente: label, platform: source.platform, estado: 'no_medida', motivo: null, detalle: null, repos: 0, faltan: [], fallidos: [] };
    estado.push(e);
    const l = await P.run('repos.list', { source, ...(credential ? { credential } : {}) }, { env: envConector });
    if (!l.ok) {
      Object.assign(e, { motivo: l.reason, detalle: porque(l) });
      out(`::warning::la fuente ${label} no se midió (${l.reason}): ${e.detalle}`);
      continue;
    }
    let copias = new Set();
    try { copias = new Set((teamData ? TR.harnessCopies(teamData, source.platform) : []).filter((c) => !c.measured).map((c) => String(c.id).toLowerCase())); } catch (_) { /* sin copias declaradas */ }
    const items = l.value.filter((x) => x && typeof x.id === 'string' && x.archived !== true && !copias.has(x.id.toLowerCase()));
    if (!items.length) {
      Object.assign(e, { motivo: 'no_medido', detalle: 'la fuente no devolvió ningún repo: ¿el token ve sus repos?' });
      out(`::warning::la fuente ${label} no devolvió ningún repo: no se midió nada de ella (¿el token ve sus repos?)`);
      continue;
    }
    // lo que la fuente devolvió, archivados y copias incluidos: un declarado que está ahí no falta, aunque no se clone
    const vistos = new Set(l.value.filter((x) => x && typeof x.id === 'string').map((x) => x.id.toLowerCase()));
    e.faltan = declaradosDe(source, declarados).filter((id) => !vistos.has(id.toLowerCase())).sort();
    const repetidos = [];
    for (const it of items) {
      const clave = `${source.platform}|${hostKey(source)}|${it.id.toLowerCase()}`;
      if (traidos.has(clave)) { repetidos.push(`${it.id} (ya lo trajo ${traidos.get(clave)})`); continue; }
      const folder = folderFor(source, it.id, nightPlatform, taken);
      const c = await P.run('repos.clone', { source, id: it.id, dest: path.join(o.dest, folder), sparse: [...LIGHT_PATTERNS], ...(credential ? { credential } : {}) }, { env: envConector });
      if (!c.ok) { e.fallidos.push({ id: it.id, motivo: c.reason, detalle: P.limpiar(c.detail) }); taken.delete(folder.toLowerCase()); continue; }
      if (!c.value || !c.value.dir) { taken.delete(folder.toLowerCase()); continue; } // un repo vacío: nada que medir
      index[folder] = { source: label, platform: source.platform, id: it.id, group: groupOf(source, it.id) };
      traidos.set(clave, label);
      e.repos++;
    }
    if (repetidos.length) out(`::warning::la fuente ${label} se pisa con otra: ${repetidos.join(', ')} — se miden una sola vez`);
    e.estado = e.faltan.length || e.fallidos.length ? 'en_parte' : 'medida';
    if (e.faltan.length) out(`::warning::la fuente ${label} no devolvió repos declarados: ${e.faltan.join(', ')} — ¿el token los ve? La fuente queda medida en parte`);
    if (e.fallidos.length) out(`::warning::la fuente ${label}: repos que no se clonaron: ${e.fallidos.map((f) => `${f.id} (${f.motivo})`).join(', ')} — no se miden; los demás sí (medida en parte)`);
    if (e.estado !== 'medida') { e.motivo = e.fallidos.length ? e.fallidos[0].motivo : 'no_medido'; e.detalle = [e.faltan.length ? `${e.faltan.length} declarado(s) que la fuente no devolvió` : null, e.fallidos.length ? `${e.fallidos.length} repo(s) sin clonar` : null].filter(Boolean).join(' · '); }
  }
  fs.writeFileSync(path.join(o.dest, 'sources-index.json'), `${JSON.stringify(index, null, 2)}\n`);
  if (o.dashboard) {
    fs.mkdirSync(o.dashboard, { recursive: true });
    fs.writeFileSync(path.join(o.dashboard, `nightly-sources-${o.today}.json`), `${JSON.stringify({ fecha: o.today, generado: new Date().toISOString(), fuentes: estado }, null, 2)}\n`);
  }
  const n = (k) => estado.filter((x) => x.estado === k).length;
  out(`fuentes: ${estado.length} · medidas: ${n('medida')} · en parte: ${n('en_parte')} · no medidas: ${n('no_medida')} · repos clonados: ${Object.keys(index).length}`);
  return 0;
}

async function cloneDeclared(dest, env, entrada, out) {
  const creds = readCredentials(env[CREDS_VAR], out);
  const envConector = connectorEnv(env);
  const fallidos = [];
  let clonados = 0;
  const lineas = String(entrada).split('\n').filter((l) => l.trim());
  for (const [i, linea] of lineas.entries()) {
    const t = linea.indexOf('\t');
    const ruta = t < 0 ? linea : linea.slice(0, t);
    let src = null;
    try { src = JSON.parse(linea.slice(t + 1)); } catch (_) { /* abajo */ }
    const malos = isObject(src) ? TR.repoProblems(src, 'source', { platforms: TR.PLATFORMS }) : [{ path: 'source', message: 'no es un JSON' }];
    if (t < 0 || malos.length) { out(`::warning::la línea ${i + 1} no trae «<ruta>\\t<fuente con su repo>» (${malos.map((p) => `${p.path}: ${p.message}`).join('; ') || 'sin fuente'}): no se clona`); fallidos.push(ruta || `línea ${i + 1}`); continue; }
    if (path.isAbsolute(ruta) || ruta.split(/[\\/]/).includes('..')) { out(`::warning::la ruta «${ruta}» sale del destino: no se clona`); fallidos.push(ruta); continue; }
    const { repo, ...source } = src;
    const id = idOf(src);
    const credential = creds[src.platform];
    const c = await P.run('repos.clone', { source, id, dest: path.join(dest, ruta), depth: 1, ...(credential ? { credential } : {}) }, { env: envConector });
    if (!c.ok) { out(`::warning::No se pudo clonar ${id} (${labelOf(source)}): ${c.reason}: ${P.limpiar(c.detail)}`); fallidos.push(id); continue; }
    clonados++;
  }
  out(`clonados de fuentes: ${clonados}`);
  if (fallidos.length) out(`::warning::Repos de fuentes NO clonados: ${fallidos.join(' ')} — van a figurar como NO MEDIDO, que no es lo mismo que limpio`);
  return 0;
}

function skipped(ops, formato, out) {
  const aviso = formato === 'vso' ? (t) => out(`##vso[task.logissue type=warning]${t}`) : (t) => out(`::warning::${t}`);
  const { sources } = fuentesDe(ops, (l) => aviso(l.replace(/^::warning::/, '')));
  for (const s of sources || []) aviso(`la fuente ${labelOf(s)} de nightly.sources: esta noche no la mide (todavía no lee fuentes; la mide la noche que las lee)`);
  return 0;
}

function opciones(argv) {
  const o = { dest: null, operations: null, teamRepos: null, reposJson: null, dashboard: null, today: new Date().toISOString().slice(0, 10), format: 'actions' };
  const k = { '--dir': 'dest', '--operations': 'operations', '--team-repos': 'teamRepos', '--repos-json': 'reposJson', '--dashboard': 'dashboard', '--today': 'today', '--format': 'format' };
  for (let i = 0; i < argv.length; i++) {
    if (!k[argv[i]]) return { error: `opción desconocida: ${argv[i]}` };
    o[k[argv[i]]] = argv[++i];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.today)) return { error: '--today es AAAA-MM-DD' };
  return o;
}

async function main(argv, env = process.env, out = (l) => process.stdout.write(`${l}\n`)) {
  const [cmd, ...rest] = argv;
  const USO = 'uso: sources.js declared|skipped --operations <f> · clone --dir <d> --operations <f> [--team-repos <f>] [--repos-json <f>] [--dashboard <d>] [--today <día>] · clone-declared <destino>';
  if (cmd === 'clone-declared') {
    if (!rest[0]) { process.stderr.write(`${USO}\n`); return 2; }
    return cloneDeclared(path.resolve(rest[0]), env, fs.readFileSync(0, 'utf8'), out);
  }
  const o = opciones(rest);
  if (o.error || !o.operations || !['declared', 'clone', 'skipped'].includes(cmd) || (cmd === 'clone' && !o.dest)) { process.stderr.write(`${o.error ? `${o.error}\n` : ''}${USO}\n`); return 2; }
  if (cmd === 'declared') return fuentesDe(o.operations, out).sources ? 0 : 1;
  if (cmd === 'skipped') return skipped(o.operations, o.format, out);
  return clone({ ...o, dest: path.resolve(o.dest), dashboard: o.dashboard ? path.resolve(o.dashboard) : null }, env, out);
}

module.exports = { LIGHT_PATTERNS, readCredentials, connectorEnv, declaredFor: declaradosDe, labelOf, idOf, folderFor, groupOf, main };

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`sources.js: ${P.limpiar(e && e.message)}\n`); process.exitCode = 1; });
