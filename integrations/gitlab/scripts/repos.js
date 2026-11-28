'use strict';
// repos.js — los repos de una fuente de GitLab (`{ platform, namespace, host? }`, de `nightly.sources`) para la noche:
// `repos.list` y `repos.clone` de la capa de plataforma. Habla HTTP directo con la API v4 (gitlab-http.js) y clona con
// git: en el servidor de la noche no hay glab.
//
// La lista: los proyectos del grupo y de sus subgrupos (`include_subgroups=true`), sin los archivados, de a 100 por
// página, siguiendo la cabecera `x-next-page`, con un tope de páginas (TYCON_GITLAB_MAX_PAGES, por defecto 100) y uno de
// tiempo total. Una página que falla o un tope alcanzado dejan la fuente no medida: nunca una lista más corta.
// El clon: con la credencial sólo en el entorno de cada git (`http.extraheader` por GIT_CONFIG_*: ni en los argumentos,
// que cualquier proceso ve, ni en el disco), sin seguir redirecciones (`http.followRedirects=false`), liviano (los
// patrones que pasa el núcleo, más el historial de los archivos que nombra en `history`, que se baja ahora porque
// después nadie tiene la credencial) o completo (la profundidad que pasa el núcleo, rama main). Ningún `.git/config`
// queda con la credencial. La máscara de cada cabecera sale en la salida del paso antes de usarla; la del token la pone
// quien lee el secreto (scripts/nightly/sources.js).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const HTTP = require('./gitlab-http.js');

const MAX_PAGINAS = 100;
const SIN_TOKEN = { ok: false, reason: 'sin_credencial', detail: 'falta el token de GitLab de la fuente: cargá el token en HARNESS_SOURCE_CREDENTIALS (gitlab), con read_api y read_repository' };

/** La máscara de un valor en la salida del paso (nunca en una salida que alguien captura: esa no llega a GitHub). */
const enmascarar = (v) => { if (v) process.stdout.write(`::add-mask::${v}\n`); };

async function reposList(args, ctx) {
  const token = args.credential || '';
  if (!token) return SIN_TOKEN;
  const ns = String(args.source.namespace || '');
  if (!ns) return { ok: false, reason: 'rechazado', detail: 'la fuente no trae namespace: el grupo cuyos repos se miden' };
  let server;
  try { server = HTTP.serverOf(args.source, ctx.env); } catch (e) { return { ok: false, reason: 'rechazado', detail: e.message }; }
  const max = Number(ctx.env.TYCON_GITLAB_MAX_PAGES) > 0 ? Math.floor(Number(ctx.env.TYCON_GITLAB_MAX_PAGES)) : MAX_PAGINAS;
  const deadline = HTTP.deadlineFrom(ctx.env);
  // la cabecera de la API es el token mismo: se enmascara antes del primer pedido
  enmascarar(token);
  const lista = [];
  let page = 1;
  for (;;) {
    // con los archivados: la lista dice cuáles hay (archived), y el núcleo no los clona ni los da por faltantes
    const url = `${server}/api/v4/groups/${encodeURIComponent(ns)}/projects?include_subgroups=true&per_page=100&page=${page}`;
    const r = await HTTP.getJson(url, token, { deadline, donde: `la página ${page} de los proyectos del grupo ${ns}` });
    if (!r.ok) return r;
    if (!Array.isArray(r.body) || !r.body.every((p) => p && typeof p.path_with_namespace === 'string' && typeof p.path === 'string')) {
      return { ok: false, reason: 'no_medido', detail: `la página ${page} de los proyectos del grupo ${ns} no es una lista de proyectos` };
    }
    lista.push(...r.body);
    const next = String(r.headers.get('x-next-page') || '').trim();
    if (!next) break;
    if (page >= max) return { ok: false, reason: 'no_medido', detail: `los proyectos del grupo ${ns} pasan el tope de ${max} páginas: no se mide a medias` };
    const n = Number(next);
    if (!Number.isInteger(n) || n <= page) return { ok: false, reason: 'no_medido', detail: `la página siguiente que dice el servidor («${next}») no sigue a la ${page}` };
    page = n;
  }
  const vistos = new Set();
  const value = [];
  for (const p of lista) {
    if (vistos.has(p.path_with_namespace.toLowerCase())) continue;
    vistos.add(p.path_with_namespace.toLowerCase());
    value.push({ id: p.path_with_namespace, name: p.path, archived: p.archived === true });
  }
  return { ok: true, value };
}

/** El motivo del contrato de un error de git, por su texto. */
function motivoDe(t) {
  if (/returned error: 30[1278]|redirect/i.test(t)) return ['no_medido', 'el servidor redirigió el clon a otra dirección: no se sigue, para que la credencial no salga del servidor'];
  if (/returned error: 40[13]|Authentication failed|could not read Username/i.test(t)) return ['rechazado', 'el servidor rechazó la credencial: renovalo (un token con read_api y read_repository)'];
  if (/returned error: 404|not found|does not exist/i.test(t)) return ['no_encontrado', 'el repo no existe o el token no lo ve'];
  if (/Could not resolve host|Connection refused|timed out|Failed to connect/i.test(t)) return ['red', 'no pude hablar con el servidor'];
  return ['no_medido', 'git no pudo clonar'];
}

async function reposClone(args, ctx) {
  const token = args.credential || '';
  if (!token) return SIN_TOKEN;
  let server;
  try { server = HTTP.serverOf(args.source, ctx.env); } catch (e) { return { ok: false, reason: 'rechazado', detail: e.message }; }
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/.test(args.id)) return { ok: false, reason: 'rechazado', detail: `«${args.id}» no es un proyecto de GitLab (<grupo>/<proyecto>)` };
  if (fs.existsSync(args.dest)) return { ok: false, reason: 'rechazado', detail: 'la carpeta del clon ya existe' };
  const b64 = Buffer.from(`oauth2:${token}`).toString('base64');
  enmascarar(b64);
  // git en inglés: motivoDe lee sus errores por el texto. Los lectores salen de la raíz del arnés que da el núcleo (el
  // conector puede vivir en otra carpeta)
  const { idiomaFijo, conConfigDeGit } = require(path.join(ctx.root, 'scripts', 'lib', 'clean-git-env.js'));
  const env = conConfigDeGit(idiomaFijo(ctx.env, { GIT_TERMINAL_PROMPT: '0' }),
    { 'http.followRedirects': 'false', 'http.extraheader': `Authorization: Basic ${b64}` });
  const git = (a) => spawnSync('git', a, { encoding: 'utf8', env, timeout: 10 * 60 * 1000, windowsHide: true });
  const fallar = (r) => {
    fs.rmSync(args.dest, { recursive: true, force: true });
    const t = [token, b64].reduce((s, x) => s.split(x).join('***'), `${r.stderr || ''}${r.stdout || ''}`);
    const [reason, porque] = motivoDe(t);
    return { ok: false, reason, detail: `no pude clonar ${args.id}: ${porque} (${t.trim().split('\n').pop().slice(0, 160) || 'sin detalle'})` };
  };
  const url = `${server}/${args.id}.git`;
  fs.mkdirSync(path.dirname(args.dest), { recursive: true });
  if (args.depth) {
    const r = git(['clone', '--quiet', `--depth=${args.depth}`, '--branch', 'main', url, args.dest]);
    return r.status === 0 ? { ok: true, value: { dir: args.dest } } : fallar(r);
  }
  const r = git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', url, args.dest]);
  if (r.status !== 0) return fallar(r);
  if (git(['-C', args.dest, 'rev-parse', '-q', '--verify', 'HEAD']).status !== 0) {
    fs.rmSync(args.dest, { recursive: true, force: true });
    return { ok: true, value: { dir: null, empty: true } };
  }
  git(['-C', args.dest, 'sparse-checkout', 'init', '--no-cone']);
  fs.writeFileSync(path.join(args.dest, '.git', 'info', 'sparse-checkout'), `${args.sparse.join('\n')}\n`);
  const c = git(['-C', args.dest, 'checkout', '--quiet']);
  if (c.status !== 0) return fallar(c);
  if (!args.history) return { ok: true, value: { dir: args.dest } };
  const { bajarHistorial } = require(path.join(ctx.root, 'scripts', 'lib', 'clone-history.js'));
  const h = bajarHistorial(git, args.dest, args.history);
  return { ok: true, value: { dir: args.dest, history: h.ok ? 'completa' : 'incompleta', ...(h.ok ? {} : { historyDetail: h.detail }) } };
}

module.exports = { 'repos.list': reposList, 'repos.clone': reposClone };
