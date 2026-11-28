#!/usr/bin/env node
'use strict';
// repos.js — los repos de GitHub que mide la noche: listarlos y clonarlos. Es la lógica que vivía en
// pipelines/operations/github/clone-repos.sh, que ahora delega acá conservando su interfaz y su salida.
//
// Dos usos:
//   · la capa de plataforma (scripts/lib/platform/platform.js) pide `repos.list` y `repos.clone` de una fuente
//     (`{ platform, org }`, de `nightly.sources` en operations.json);
//   · clone-repos.sh, sin fuentes declaradas, corre los dos modos de siempre:
//       node repos.js org <destino> [<team-repos.json>]   los repos de los dueños de OWNERS, livianos, en <dueño>__<repo>
//       node repos.js declared <destino>                   los de la entrada (`<ruta>\t<dueño>/<repo>`), main con
//                                                          profundidad 1 y sin el token en su config
//     La cabecera de la credencial llega por REPOS_AUTH_HEADER, ya enmascarada por clone-repos.sh en la salida del paso.
//
// Habla con GitHub por TYCON_GH_CMD (por defecto gh; un `.js` corre con node) y clona desde GITHUB_SERVER_URL (las
// pruebas usan una carpeta local). La credencial: la de la fuente (`credential`), o ORG_TOKEN (la App o el usuario de
// máquina del workflow). ORG_TOKEN_KIND dice cuál es (`app` o `user`); vacía, se averigua: sólo el token de una App lee
// `installation/repositories`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const OWNER = /^[A-Za-z0-9-]+$/;

/** La llamada a la API de GitHub por el gh de la máquina, con el token que se pase. */
function apiDe(env) {
  const cmd = env.TYCON_GH_CMD || 'gh';
  const [exe, pre] = /\.js$/i.test(cmd) ? [process.execPath, [cmd]] : [cmd, []];
  return (ruta) => {
    const r = spawnSync(exe, [...pre, 'api', '-H', 'Accept: application/vnd.github+json', ruta], { encoding: 'utf8', maxBuffer: 1 << 28, env, windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, motivo: String((r.stderr || (r.error && r.error.message) || '')).trim().split('\n')[0] };
    try { return { ok: true, valor: JSON.parse(r.stdout) }; } catch { return { ok: false, motivo: 'la respuesta no es JSON' }; }
  };
}

/**
 * Los repos de unos dueños según la credencial: `{ items, warns, errores, fallo, cortado }`. `items`, en orden y sin
 * repetir: `{ full, name, archived, copy }`. `errores` son las líneas que el modo de siempre mandaba a la salida de
 * errores; `cortado`, que no se pudo seguir (un listado entero que falla); `fallo`, que un dueño no se pudo listar.
 */
function listar({ env, owners, kind, prefix = '', copias = new Set() }) {
  const api = apiDe(env);
  const out = { items: [], warns: [], errores: [], fallo: false, cortado: false };
  if (kind && !['app', 'user'].includes(kind)) { out.errores.push(`ORG_TOKEN_KIND «${kind}» no es app ni user`); out.cortado = true; return out; }
  if (!kind) {
    // sin decir cuál (un workflow copiado antes de que existiera la variable): installation/repositories sólo contesta al
    // token de una App; con el de un usuario responde 403 y vale el camino del usuario
    const p = api('installation/repositories?per_page=1');
    kind = p.ok && p.valor && Array.isArray(p.valor.repositories) ? 'app' : 'user';
  }
  const vistos = new Set();
  const emitir = (x) => {
    if (!x || typeof x.name !== 'string' || !x.owner || typeof x.owner.login !== 'string') return;
    const full = `${x.owner.login}/${x.name}`;
    if (vistos.has(full.toLowerCase())) return;
    vistos.add(full.toLowerCase());
    if (prefix && !x.name.startsWith(prefix)) return;
    out.items.push({ full, name: x.name, archived: x.archived === true, copy: copias.has(full.toLowerCase()) });
  };
  /** Todas las páginas de una ruta; `campo`: la lista viene dentro de ese campo (installation/repositories). null = falló. */
  const todo = (ruta, campo) => {
    const lista = [];
    for (let page = 1; page <= 50; page++) {
      const r = api(`${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const l = r.ok && r.valor ? (campo ? r.valor[campo] : r.valor) : null;
      if (!Array.isArray(l)) { out.errores.push(`no pude listar ${ruta} (página ${page}): ${r.motivo || 'no es una lista'}`); return null; }
      lista.push(...l);
      if (l.length < 100) break;
    }
    return lista;
  };
  const validos = owners.filter((o) => {
    if (OWNER.test(o)) return true;
    out.errores.push(`«${o}» no es un dueño de GitHub`); out.fallo = true; return false;
  });
  if (kind === 'app') {
    // el token de la App sólo ve los repos donde está instalada: ésa es la lista, privados incluidos
    const lista = todo('installation/repositories', 'repositories');
    if (!lista) { out.cortado = true; return out; }
    for (const o of validos) {
      const suyos = lista.filter((x) => x && x.owner && String(x.owner.login).toLowerCase() === o.toLowerCase());
      if (!suyos.length) out.warns.push(`la GitHub App no está instalada en ningún repo de ${o}: sus repos no se miden`);
      suyos.forEach(emitir);
    }
    return { ...out, validos };
  }
  let mios = null;
  for (const o of validos) {
    const u = api(`users/${o}`);
    if (!u.ok || !u.valor || !u.valor.type) { out.errores.push(`no pude saber qué es ${o}: ${u.motivo || 'sin tipo'}`); out.fallo = true; continue; }
    if (u.valor.type === 'Organization') {
      const l = todo(`orgs/${o}/repos?type=all`);
      if (!l) { out.fallo = true; continue; }
      l.forEach(emitir);
      continue;
    }
    // una cuenta de usuario: users/<dueño>/repos trae sólo los públicos; los privados que la credencial ve, por user/repos
    const l = todo(`users/${o}/repos?type=owner`);
    if (!l) { out.fallo = true; continue; }
    if (mios === null) mios = todo('user/repos?affiliation=owner,collaborator');
    if (!mios) { out.fallo = true; continue; }
    [...l, ...mios.filter((x) => x && x.owner && String(x.owner.login).toLowerCase() === o.toLowerCase())].forEach(emitir);
  }
  return { ...out, validos };
}

// ── el clon ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const gitRun = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts });

/** La cabecera de la credencial para git: `AUTHORIZATION: basic <base64 de x-access-token:token>`. */
function cabecera(token) {
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { auth, header: `AUTHORIZATION: basic ${auth}` };
}

/** Cuántos `.git` hay hasta `max` niveles abajo de `dir` (lo que contaba `find -maxdepth 4 -name .git`). */
function contarGit(dir, max) {
  let n = 0;
  const walk = (d, nivel) => {
    if (nivel > max) return;
    let hijos = [];
    try { hijos = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const h of hijos) {
      if (h.name === '.git') { n++; continue; }
      if (h.isDirectory()) walk(path.join(d, h.name), nivel + 1);
    }
  };
  walk(dir, 1);
  return n;
}

/** Las líneas terminadas de la entrada (como `while read`: una última línea sin salto no se lee). */
function lineasDe(texto) {
  const partes = String(texto).split('\n');
  partes.pop();
  return partes;
}

/** El modo `declared` de clone-repos.sh. */
function declared(dest, header, env, entrada) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const fallidos = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const linea of lineasDe(entrada)) {
    const i = linea.indexOf('\t');
    const ruta = i < 0 ? linea : linea.slice(0, i);
    const id = i < 0 ? '' : linea.slice(i + 1);
    if (!ruta) continue;
    if (!NAME.test(id)) {
      console.log(`::warning::${ruta} no declara «github: <dueño>/<repo>» en repos.json: no se clona`);
      fallidos.push(ruta); continue;
    }
    if (ruta.startsWith('/') || ruta.includes('..')) { console.log(`::warning::la ruta «${ruta}» sale del destino: no se clona`); fallidos.push(ruta); continue; }
    fs.mkdirSync(path.dirname(path.join(dest, ruta)), { recursive: true });
    const r = gitRun(['-c', `http.extraheader=${header}`, 'clone', '--quiet', '--depth=1', '--branch', 'main', `${server}/${id}.git`, path.join(dest, ruta)], { env });
    if (r.status !== 0) {
      console.log(`::warning::No se pudo clonar ${id}: ${`${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(0, 2).map((l) => `${l} `).join('')}`);
      fallidos.push(id);
    }
  }
  console.log(`clonados: ${contarGit(dest, 4)}`);
  if (fallidos.length) console.log(`::warning::Repos NO clonados: ${fallidos.join(' ')} — van a figurar como NO MEDIDO, que no es lo mismo que limpio`);
  return 0;
}

/** El modo `org` de clone-repos.sh: listar, clonar liviano y avisar lo que falta. */
function org(dest, header, env, teamRepos) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const reader = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'team-repos.js'));
  const errorDeLista = (errores) => {
    console.log(`::error::No se pudieron listar los repos de la organización: ${errores.slice(-3).map((l) => `${l} `).join('')} — el barrido no se hace a medias`);
    return 1;
  };
  fs.mkdirSync(dest, { recursive: true });
  const copias = new Set();
  let data = null;
  if (teamRepos && fs.existsSync(teamRepos)) {
    // las copias, con la regla del lector: un team-repos.json que no valida es un error, no «no hay copias»
    const r = reader.load(teamRepos);
    if (!r.ok) return errorDeLista([`team-repos.json no valida: ${r.problems.map((p) => `${p.path || '(el archivo)'}: ${p.message}`).join('; ')}`]);
    data = r.data;
    for (const c of reader.harnessCopies(r.data, 'github')) if (!c.measured) copias.add(c.id.toLowerCase());
  }
  const owners = String(env.OWNERS || env.GITHUB_REPOSITORY_OWNER || '').split(';').map((s) => s.trim()).filter(Boolean);
  if (!owners.length) return errorDeLista(['no hay dueños que mirar (OWNERS y GITHUB_REPOSITORY_OWNER vacíos)']);
  const l = listar({ env: { ...env, GH_TOKEN: env.ORG_TOKEN }, owners, kind: String(env.ORG_TOKEN_KIND || ''), prefix: String(env.PREFIX || ''), copias });
  if (l.cortado || l.fallo) return errorDeLista(l.errores);
  // lo que team-repos.json declara de estos dueños: si no se ve ninguno, la credencial no los está viendo
  const ownerSet = new Set((l.validos || []).map((o) => o.toLowerCase()));
  const d = data || {};
  const decl = [d.public, d.profile, d.operations, d.maintainers, ...(d.harness_copies || [])]
    .filter((x) => x && x.platform === 'github' && ownerSet.has(String(x.org).toLowerCase())).map((x) => `${x.org}/${x.repo}`);
  const declarados = [...new Set(decl)].join(' ');
  let total = 0; const saltadas = []; const fallidos = [];
  for (const w of l.warns) console.log(`::warning::${w}`);
  for (const it of l.items) {
    if (!NAME.test(it.full)) continue;
    if (it.copy) { saltadas.push(it.full); continue; }
    total++;
    const destino = path.join(dest, `${it.full.split('/')[0]}__${it.full.split('/')[1]}`);
    const c = gitRun(['-c', `http.extraheader=${header}`, 'clone', '--quiet', '--filter=blob:none', '--no-checkout', `${server}/${it.full}.git`, destino], { env });
    if (c.status !== 0) {
      console.log(`   ✗ ${it.full}: ${`${c.stdout || ''}${c.stderr || ''}`.split('\n')[0].slice(0, 160)}`);
      fallidos.push(`${it.full}(clone)`); continue;
    }
    // un repo VACÍO no tiene HEAD: no es un fallo, es un repo sin nada que medir
    if (gitRun(['-C', destino, 'rev-parse', '-q', '--verify', 'HEAD'], { env }).status !== 0) { fs.rmSync(destino, { recursive: true, force: true }); continue; }
    // el clon liviano baja contenido después: el token queda en la config de esos clones, en un trabajo que sólo lee Markdown
    gitRun(['-C', destino, 'config', 'http.extraheader', header], { env });
    gitRun(['-C', destino, 'sparse-checkout', 'init', '--no-cone'], { env });
    try { fs.writeFileSync(path.join(destino, '.git', 'info', 'sparse-checkout'), '**/*.md\n.advisors/**\n.tycon/**\n'); } catch { fallidos.push(`${it.full}(checkout)`); continue; }
    if (gitRun(['-C', destino, 'checkout', '--quiet'], { env }).status !== 0) fallidos.push(`${it.full}(checkout)`);
  }
  const clonados = fs.readdirSync(dest, { withFileTypes: true }).filter((x) => x.isDirectory()).length;
  console.log(`repos vistos: ${total} · clonados: ${clonados}`);
  if (total === 0) {
    if (declarados) console.log(`::warning::Cero repos vistos, y team-repos.json declara repos de estos dueños (${declarados}): la credencial no los ve — ¿la App no está instalada en ellos, o el usuario de máquina no ve los privados? No se midió nada`);
    else console.log(`::warning::Cero repos vistos: no se midió nada (¿la credencial ve los repos de ${env.OWNERS || env.GITHUB_REPOSITORY_OWNER || ''}${env.PREFIX ? `, con el prefijo ${env.PREFIX}` : ''}?)`);
  }
  if (saltadas.length) console.log(`copias del arnés que no se miden: ${saltadas.join(' ')}`);
  if (fallidos.length) console.log(`::warning::Repos NO medidos: ${fallidos.join(' ')} — el barrido está incompleto (¿la credencial puede leerlos?)`);
  return 0;
}

// ── las operaciones de la capa ───────────────────────────────────────────────────────────────────────────────────────

const tokenDe = (args, ctx) => args.credential || ctx.env.ORG_TOKEN || '';
const SIN_TOKEN = { ok: false, reason: 'sin_credencial', detail: 'falta el token de GitHub de la fuente: cargá el token en HARNESS_SOURCE_CREDENTIALS (github) o configurá la credencial de la organización (ORG_TOKEN)' };

/** El motivo del contrato de un error de gh o de git, sin el texto crudo de la credencial. */
function motivoDe(texto) {
  const t = String(texto || '');
  if (/HTTP 40[13]|Bad credentials|Authentication failed|could not read Username|403/i.test(t)) return 'rechazado';
  if (/HTTP 404|Not Found|not found|does not exist/i.test(t)) return 'no_encontrado';
  if (/Could not resolve host|Connection refused|timed out|network/i.test(t)) return 'red';
  return 'no_medido';
}
const limpio = (t, secretos) => secretos.filter(Boolean).reduce((s, x) => s.split(x).join('***'), String(t || '')).split('\n')[0].slice(0, 200);

/** `repos.list` de una fuente `{ platform, org }`: `[{ id, name, archived }]`. */
function reposList(args, ctx) {
  const token = tokenDe(args, ctx);
  if (!token) return SIN_TOKEN;
  const o = String(args.source.org || '');
  if (!OWNER.test(o)) return { ok: false, reason: 'rechazado', detail: `«${o}» no es un dueño de GitHub` };
  // ORG_TOKEN_KIND dice qué es ORG_TOKEN; el token propio de la fuente puede ser otro, y su tipo se averigua
  const kind = args.credential ? '' : String(ctx.env.ORG_TOKEN_KIND || '');
  const l = listar({ env: { ...ctx.env, GH_TOKEN: token }, owners: [o], kind, prefix: String(ctx.env.PREFIX || '') });
  if (l.cortado || l.fallo) {
    const detalle = limpio(l.errores.join('; '), [token]);
    return { ok: false, reason: motivoDe(detalle), detail: `no pude listar los repos de ${o}: ${detalle}` };
  }
  return { ok: true, value: l.items.map((x) => ({ id: x.full, name: x.name, archived: x.archived })) };
}

/** `repos.clone` de un repo de la lista: liviano (`sparse`) o completo (`depth`), sin la credencial en su config. */
function reposClone(args, ctx) {
  const token = tokenDe(args, ctx);
  if (!token) return SIN_TOKEN;
  if (!NAME.test(args.id)) return { ok: false, reason: 'rechazado', detail: `«${args.id}» no es un repo de GitHub (<dueño>/<repo>)` };
  if (fs.existsSync(args.dest)) return { ok: false, reason: 'rechazado', detail: 'la carpeta del clon ya existe' };
  const { auth, header } = cabecera(token);
  // la máscara va a la salida del paso antes de usar la cabecera (una salida capturada no llega a GitHub)
  process.stdout.write(`::add-mask::${auth}\n`);
  const server = ctx.env.GITHUB_SERVER_URL || 'https://github.com';
  // git en inglés: motivoDe lee sus errores por el texto. El lector sale de la raíz del arnés que da el núcleo (el
  // conector puede vivir en otra carpeta)
  const { idiomaFijo } = require(path.join(ctx.root, 'scripts', 'lib', 'clean-git-env.js'));
  const env = idiomaFijo(ctx.env, { GIT_TERMINAL_PROMPT: '0' });
  const H = ['-c', `http.extraheader=${header}`];
  const fallar = (r) => {
    fs.rmSync(args.dest, { recursive: true, force: true });
    const t = limpio(`${r.stderr || ''}${r.stdout || ''}`, [token, auth]);
    return { ok: false, reason: motivoDe(t), detail: `no pude clonar ${args.id}: ${t || 'sin detalle'}` };
  };
  fs.mkdirSync(path.dirname(args.dest), { recursive: true });
  if (args.depth) {
    const r = gitRun([...H, 'clone', '--quiet', `--depth=${args.depth}`, '--branch', 'main', `${server}/${args.id}.git`, args.dest], { env });
    return r.status === 0 ? { ok: true, value: { dir: args.dest } } : fallar(r);
  }
  const r = gitRun([...H, 'clone', '--quiet', '--filter=blob:none', '--no-checkout', `${server}/${args.id}.git`, args.dest], { env });
  if (r.status !== 0) return fallar(r);
  if (gitRun(['-C', args.dest, 'rev-parse', '-q', '--verify', 'HEAD'], { env }).status !== 0) {
    fs.rmSync(args.dest, { recursive: true, force: true });
    return { ok: true, value: { dir: null, empty: true } };
  }
  gitRun(['-C', args.dest, 'sparse-checkout', 'init', '--no-cone'], { env });
  fs.writeFileSync(path.join(args.dest, '.git', 'info', 'sparse-checkout'), `${args.sparse.join('\n')}\n`);
  const c = gitRun(['-C', args.dest, ...H, 'checkout', '--quiet'], { env });
  return c.status === 0 ? { ok: true, value: { dir: args.dest } } : fallar(c);
}

module.exports = { 'repos.list': reposList, 'repos.clone': reposClone, listar, cabecera, declared, org };

if (require.main === module) {
  const [modo, dest, teamRepos] = process.argv.slice(2);
  const header = process.env.REPOS_AUTH_HEADER || '';
  if (!['org', 'declared'].includes(modo) || !dest || !header) {
    process.stderr.write('uso: REPOS_AUTH_HEADER=<cabecera> node repos.js org <destino> [<team-repos.json>] | declared <destino>\n');
    process.exit(2);
  }
  const env = { ...process.env };
  delete env.REPOS_AUTH_HEADER;
  process.exitCode = modo === 'declared' ? declared(dest, header, env, fs.readFileSync(0, 'utf8')) : org(dest, header, env, teamRepos);
}
