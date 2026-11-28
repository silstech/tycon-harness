'use strict';
// nightly-sources.test.js — la noche mide los repos de las fuentes que declara operations.json (`nightly.sources`): las
// operaciones de fuente de la capa (repos.list y repos.clone), los conectores de GitHub y de GitLab, el paso común
// (scripts/nightly/sources.js), clone-repos.sh, los workflows, la revisión de dependencias, la paridad, las métricas y
// el tablero. GitLab se prueba contra servidores https de laboratorio con un certificado propio (la API y git por
// http-backend): el código no abre http para las pruebas. Nunca toca la red.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = path.join(ROOT, 'scripts', 'nightly', 'sources.js');
const PLATFORM = path.join(ROOT, 'scripts', 'lib', 'platform', 'platform.js');
const CLONE_SH = path.join(ROOT, 'pipelines', 'operations', 'github', 'clone-repos.sh');
const FAKE_GH = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-gh.js');
const FAKE = path.join(ROOT, 'scripts', 'tests', 'lib', 'fake-platform');
const OC = () => require(path.join(ROOT, 'scripts', 'lib', 'operations-config.js'));
const P = () => require(PLATFORM);
const C = () => require(path.join(ROOT, 'scripts', 'lib', 'platform', 'contract.js'));

const dirs = [];
const servers = [];
test.after(() => { for (const s of servers) s.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const write = (dir, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } };
const { sinGitDelPadre } = require(path.join(ROOT, 'scripts', 'lib', 'clean-git-env.js'));
// sin las variables que git le pasa a sus ganchos: un `init --bare` que heredara GIT_DIR reiniciaría el repo de verdad
const git = (cwd, args, env) => {
  const fecha = '2026-01-01T00:00:00Z';
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8',
    env: { ...sinGitDelPadre(), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a', GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const TOKEN = ['glpat', 'secreto', '1234'].join('-');
const GH_TOKEN = ['ghs', 'secreto', '5678'].join('_');

/** Un proceso hijo sin bloquear el bucle (los servidores de laboratorio viven en este proceso). */
function run(cmd, args, { env, input, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, cwd: cwd || ROOT });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, all: out + err }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

// ── el laboratorio https ─────────────────────────────────────────────────────────────────────────────────────────────

let CERT = null;
/** Un certificado propio para localhost, generado una vez por corrida. */
function cert() {
  if (CERT) return CERT;
  const d = tmp('cert-');
  const key = path.join(d, 'key.pem'); const crt = path.join(d, 'cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `sin openssl no hay laboratorio https: ${r.stderr}`);
  CERT = { key: fs.readFileSync(key), cert: fs.readFileSync(crt), file: crt };
  return CERT;
}

/** git http-backend detrás del servidor https de laboratorio. */
function gitBackend(req, res, root, pathInfo, query) {
  const env = { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo, QUERY_STRING: query || '',
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_ADDR: '127.0.0.1',
    GIT_PROTOCOL: req.headers['git-protocol'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '' };
  const p = spawn('git', ['http-backend'], { env });
  req.pipe(p.stdin);
  let buf = Buffer.alloc(0); let head = false;
  p.stdout.on('data', (d) => {
    if (head) { res.write(d); return; }
    buf = Buffer.concat([buf, d]);
    let i = buf.indexOf('\r\n\r\n'); let sep = 4;
    if (i < 0) { i = buf.indexOf('\n\n'); sep = 2; }
    if (i < 0) return;
    head = true;
    let status = 200;
    for (const l of buf.slice(0, i).toString().split(/\r?\n/)) {
      const j = l.indexOf(':'); if (j < 0) continue;
      const k = l.slice(0, j).trim(); const v = l.slice(j + 1).trim();
      if (/^status$/i.test(k)) status = parseInt(v, 10); else res.setHeader(k, v);
    }
    res.writeHead(status);
    res.write(buf.slice(i + sep));
  });
  p.stdout.on('end', () => res.end());
}

/**
 * Un GitLab de laboratorio: la API v4 de los proyectos de un grupo (paginada por x-next-page) y git por http-backend.
 * `grupos`: { "<grupo>": [ [proyectos de la página 1], [de la 2], … ] }. `falla`: { "<página>": status } o `todo: status`.
 * `redirige`: la dirección a la que contesta 302 (API y git). Anota cada pedido con sus cabeceras.
 */
async function gitlab({ grupos = {}, falla = {}, redirige = null, demora = 0, repos = null } = {}) {
  const c = cert();
  const pedidos = [];
  const server = https.createServer({ key: c.key, cert: c.cert }, (req, res) => {
    const u = new URL(req.url, 'https://localhost');
    pedidos.push({ path: u.pathname, query: u.search, headers: req.headers });
    if (redirige) { res.writeHead(302, { location: `${redirige}${req.url}` }); res.end(); return; }
    const m = u.pathname.match(/^\/api\/v4\/groups\/([^/]+)\/projects$/);
    if (m) {
      if (req.headers['private-token'] !== TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"401 Unauthorized"}'); return; }
      if (falla.todo) { res.writeHead(falla.todo, { 'content-type': 'application/json' }); res.end('{"message":"falla"}'); return; }
      const grupo = decodeURIComponent(m[1]);
      const paginas = grupos[grupo];
      if (!paginas) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"404 Group Not Found"}'); return; }
      const page = parseInt(u.searchParams.get('page') || '1', 10);
      if (falla[page]) { res.writeHead(falla[page]); res.end('{"message":"rota"}'); return; }
      const lista = paginas[page - 1] || [];
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-next-page': page < paginas.length ? String(page + 1) : '' });
        res.end(JSON.stringify(lista));
      }, demora);
      return;
    }
    if (repos && /\.git(\/|$)/.test(u.pathname)) {
      const auth = String(req.headers.authorization || '');
      const esperado = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`;
      if (auth !== esperado) { res.writeHead(401, { 'www-authenticate': 'Basic realm="lab"' }); res.end(); return; }
      gitBackend(req, res, repos, u.pathname, u.search.slice(1));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { port: server.address().port, pedidos, url: `https://localhost:${server.address().port}` };
}

const proyecto = (ns, name, archived = false) => ({ id: Math.floor(Math.random() * 1e6), path: name, path_with_namespace: `${ns}/${name}`, archived });

/** Un repo bare en la carpeta de repos del laboratorio, con su contenido en main. */
function repoBare(root, full, files) {
  const bare = path.join(root, `${full}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--quiet', '--bare']); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']); git(bare, ['config', 'http.receivepack', 'false']);
  const s = path.join(tmp('semilla-'), 'x');
  git(path.dirname(s), ['clone', '--quiet', bare, s]);
  write(s, files); git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'uno']); git(s, ['commit', '--quiet', '--allow-empty', '-m', 'dos']);
  git(s, ['branch', '-M', 'main']); git(s, ['push', '--quiet', 'origin', 'main']);
  return bare;
}

/** La carpeta de integraciones (copias: la prueba no toca el árbol) y un árbol con su perfil y su team-repos.json. */
function mundo({ platform = { default: 'github' }, team = null, extra = {} } = {}) {
  const ints = tmp('plataformas-');
  fs.cpSync(FAKE, path.join(ints, 'fake-platform'), { recursive: true });
  for (const n of ['azure-devops', 'github', 'gitlab']) fs.cpSync(path.join(ROOT, 'integrations', n), path.join(ints, n), { recursive: true });
  for (const [n, m] of Object.entries(extra)) { fs.mkdirSync(path.join(ints, n, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(ints, n, 'integration.json'), JSON.stringify(m)); }
  const tree = tmp('arbol-'); const home = tmp('casa-');
  fs.writeFileSync(path.join(tree, 'team-profile.json'), JSON.stringify({ integrations: { platform } }));
  const doc = team || { version: 1, public: { platform: 'github', org: 'acme', repo: 'arnes' }, profile: { platform: 'github', org: 'acme', repo: 'perfil' }, operations: { platform: 'github', org: 'acme', repo: 'operaciones' } };
  fs.writeFileSync(path.join(tree, 'team-repos.json'), JSON.stringify(doc));
  // sin las variables que git le pasa a sus ganchos: los git de los hijos (los conectores, las métricas) operan sobre
  // el clon, nunca sobre el repo de verdad
  const env = { ...sinGitDelPadre(), HOME: home, USERPROFILE: home, TYCON_HOME: path.join(home, '.tycon'), TYCON_INTEGRATIONS_DIR: ints, TYCON_TREE: tree,
    NODE_EXTRA_CA_CERTS: cert().file, GIT_SSL_CAINFO: cert().file, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (/^(TYCON_(ADO_ORG|PLATFORM|PROFILE|GH_CMD|GLAB_CMD|GITLAB_PORT|GITLAB_MAX_PAGES|GITLAB_DEADLINE_MS)|HARNESS_SOURCE_CREDENTIALS|OWNERS|ORG_TOKEN|ORG_TOKEN_KIND|PREFIX|GITHUB_SERVER_URL|GH_TOKEN|GITHUB_TOKEN|FAKE_PLATFORM_.*)$/.test(k)) delete env[k];
  return { env, tree, ints, teamRepos: path.join(tree, 'team-repos.json') };
}

/** Un operations.json mínimo válido con las fuentes que se pasen. */
function operations(dir, sources, extra = {}) {
  const f = path.join(dir, 'operations.json');
  const doc = { version: 1, owners: { default: 'lider' }, ...extra };
  if (sources !== undefined) doc.nightly = { sources };
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
}

/** La salida de platform.js: las líneas de máscara arriba y el JSON del resultado. */
function resultado(out) {
  const i = out.indexOf('\n{') >= 0 ? out.indexOf('\n{') + 1 : out.indexOf('{');
  return JSON.parse(out.slice(i));
}
const capa = (m, op, args, extraEnv = {}) => run(process.execPath, [PLATFORM, op, '--args', JSON.stringify(args)], { env: { ...m.env, ...extraEnv } });

const GL_SRC = (port, ns = 'acme') => ({ platform: 'gitlab', host: 'localhost', namespace: ns });

// ── el contrato y la capa ────────────────────────────────────────────────────────────────────────────────────────────

test('T1 Contrato_ReposListYClone @story-1.6 @ac-1', async () => {
  const ops = C().OPERATIONS;
  for (const op of ['repos.list', 'repos.clone']) {
    assert.ok(ops.includes(op), `${op} está en el contrato`);
    assert.ok(C().SOURCE_OPERATIONS.includes(op), `${op} es de fuente`);
    assert.strictEqual(C().areaOf(op), null, `${op} no va por un área del perfil`);
  }
  // un conector que no las declara contesta no_soportado
  const m = mundo({ extra: { otra: { name: 'otra', label: 'Otra', kind: 'platform', connector: 'scripts/connector.js', operations: ['ci.read'] } } });
  const r = await P().run('repos.list', { source: { platform: 'azure', org: 'acme', project: 'P' } }, { env: m.env });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'no_soportado', JSON.stringify(r));
});

test('T2 Conformidad_GithubGitlabYPrueba @story-1.6 @ac-1', async () => {
  for (const n of ['github', 'gitlab', 'fake-platform']) {
    const man = JSON.parse(fs.readFileSync(path.join(n === 'fake-platform' ? FAKE : path.join(ROOT, 'integrations', n), 'integration.json'), 'utf8'));
    for (const op of ['repos.list', 'repos.clone']) assert.ok(man.operations.includes(op), `${n} declara ${op}`);
    const m = mundo();
    Object.assign(m.env, { TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: path.join(tmp('gh-'), 'e.json'), TYCON_FAKE_PLATFORM_TOKEN: 'x' });
    fs.writeFileSync(m.env.FAKE_GH_STATE, '{}');
    const r = await P().conformance(n, { env: m.env });
    assert.deepStrictEqual(r.problems, [], `${n}: ${JSON.stringify(r)}`);
  }
});

test('T3 Capa_FuenteGitlabConPerfilGithub @story-1.6 @ac-2', () => {
  const m = mundo({ platform: { default: 'github', workItems: 'github' } });
  const c = P().choose('repos.list', { env: m.env, source: { platform: 'gitlab', namespace: 'acme' } });
  assert.deepStrictEqual(c.value, { connector: 'gitlab', origin: 'fuente' });
  const sin = P().choose('repos.list', { env: m.env });
  assert.strictEqual(sin.ok, false); assert.strictEqual(sin.reason, 'sin_plataforma'); assert.match(sin.detail, /fuente/);
});

// ── operations.json ──────────────────────────────────────────────────────────────────────────────────────────────────

test('T4 Operaciones_FuentesValidas @story-1.6 @ac-3', () => {
  // el lector viaja solo: la forma de cada fuente se la da sources.js (lo que corre la noche)
  require(SOURCES);
  const base = { version: 1, owners: { default: 'lider' } };
  const ok = OC().parse(JSON.stringify({ ...base, nightly: { sources: [
    { platform: 'github', org: 'acme' }, { platform: 'gitlab', namespace: 'acme/producto' }, { platform: 'gitlab', host: 'gitlab.example.com', namespace: 'g' },
  ] } }));
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.problems));
  assert.strictEqual(ok.sectionProblems, undefined);
  assert.strictEqual(ok.data.nightly.sources.length, 3);
  const conRepo = OC().parse(JSON.stringify({ ...base, nightly: { sources: [{ platform: 'gitlab', namespace: 'acme', repo: 'web' }] } }));
  assert.ok(conRepo.sectionProblems && conRepo.sectionProblems.nightly.some((p) => /sources\.0\.repo/.test(p.path)), JSON.stringify(conRepo));
  const sinClave = OC().parse(JSON.stringify({ ...base, nightly: { sources: [{ platform: 'github' }] } }));
  assert.ok(sinClave.sectionProblems.nightly.some((p) => /sources\.0\.org/.test(p.path) && /falta/.test(p.message)));
});

test('T5 Operaciones_FuenteMalEscritaNoAnula @story-1.6 @ac-3', async () => {
  require(SOURCES);
  const r = OC().parse(JSON.stringify({ version: 1, owners: { default: 'lider' }, nightly: { sources: [{ platform: 'bitbucket', org: 'x' }] } }));
  assert.strictEqual(r.ok, true, 'el resto del archivo vale');
  assert.strictEqual(r.data.owners.default, 'lider');
  assert.strictEqual(r.data.nightly, undefined, 'sin la sección rota');
  assert.ok(r.sectionProblems.nightly.some((p) => p.path === 'nightly.sources.0.platform'), JSON.stringify(r.sectionProblems));
  // la noche lo dice y sigue con lo de hoy
  const dir = tmp('ops-');
  const f = operations(dir, [{ platform: 'bitbucket', org: 'x' }]);
  const d = await run(process.execPath, [SOURCES, 'declared', '--operations', f], { env: mundo().env });
  assert.strictEqual(d.code, 1);
  assert.match(d.out, /::warning::[^\n]*nightly[^\n]*nightly\.sources\.0\.platform/);
});

// ── la noche de GitHub sin fuentes y las métricas ────────────────────────────────────────────────────────────────────

/** Un servidor git de archivos con repos de GitHub y el estado del gh de mentira. */
function githubLab(base, repos = ['web', 'api']) {
  const server = path.join(base, 'server');
  for (const name of repos) {
    const bare = path.join(server, 'acme', `${name}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, ['init', '--quiet', '--bare']); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const s = path.join(base, 'seed', name);
    git(base, ['clone', '--quiet', bare, s]);
    write(s, { 'README.md': `# ${name}\n`, '.tycon/x.json': '{}\n', 'package.json': '{}\n' });
    git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'x']); git(s, ['branch', '-M', 'main']); git(s, ['push', '--quiet', 'origin', 'main']);
  }
  const state = path.join(base, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ user: 'bot', owners: { acme: 'Organization' }, repos: { acme: repos.map((name) => ({ name })) } }));
  return { server, state };
}

test('T6 Metricas_OwnersIgnoradoAvisa @story-1.6 @ac-4', async () => {
  const m = mundo();
  const base = tmp('owners-');
  const lab = githubLab(base);
  const f = operations(base, [{ platform: 'github', org: 'acme' }]);
  const r = await run('bash', [CLONE_SH, '--org', path.join(base, 'repos'), '--team-repos', m.teamRepos], { cwd: base,
    env: { ...m.env, OPERATIONS_FILE: f, ORG_TOKEN: GH_TOKEN, ORG_TOKEN_KIND: 'user', OWNERS: 'otro', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: lab.state, GITHUB_SERVER_URL: `file://${lab.server}` } });
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /::warning::[^\n]*METRICS_OWNERS[^\n]*se ignora/);
  assert.deepStrictEqual(fs.readdirSync(path.join(base, 'repos')).filter((x) => !x.endsWith('.json')).sort(), ['acme__api', 'acme__web']);
});

test('T7 Noche_SinFuentes_IgualQueHoy @story-1.6 @ac-5', async () => {
  const m = mundo();
  for (const conArchivo of [false, true]) {
    const base = tmp('sin-fuentes-');
    const lab = githubLab(base);
    const env = { ...m.env, ORG_TOKEN: GH_TOKEN, ORG_TOKEN_KIND: 'user', OWNERS: 'acme', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: lab.state, GITHUB_SERVER_URL: `file://${lab.server}` };
    if (conArchivo) env.OPERATIONS_FILE = operations(base);
    const r = await run('bash', [CLONE_SH, '--org', path.join(base, 'repos'), '--team-repos', m.teamRepos], { cwd: base, env });
    assert.strictEqual(r.code, 0, r.all);
    assert.deepStrictEqual(fs.readdirSync(path.join(base, 'repos')).sort(), ['acme__api', 'acme__web'], 'sin índice ni carpetas nuevas');
    assert.match(r.out, /^repos vistos: 2 · clonados: 2$/m);
    assert.ok(fs.existsSync(path.join(base, 'repos', 'acme__web', 'README.md')) && !fs.existsSync(path.join(base, 'repos', 'acme__web', 'package.json')), 'el clon liviano de siempre');
    assert.doesNotMatch(r.out, /nightly|METRICS_OWNERS/);
  }
});

test('T8 Github_PruebasDeHoyPasan @story-1.6 @ac-5', (t) => {
  const a = spawnSync(process.execPath, ['--test', path.join(ROOT, 'scripts', 'tests', 'operations-github-workflows.test.js')], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(a.status, 0, a.stdout.slice(-3000));
  const b = spawnSync('bash', [path.join(ROOT, 'scripts', 'tests', 'open-pr-per-finding-github.test.sh')], { encoding: 'utf8', cwd: ROOT });
  assert.strictEqual(b.status, 0, (b.stdout + b.stderr).slice(-3000));
  // sin cambiar una línea respecto de main, salvo la lista de secretos permitidos, que suma HARNESS_SOURCE_CREDENTIALS
  // (un secreto nuevo se autoriza a la vista, en la lista, nunca en silencio)
  const base = baseDelDiff();
  // sin base, la comparación con main no se hizo: no medido, nunca verde
  if (!base) t.skip('no medido: no hay base para comparar con main (ni TYCON_DIFF_BASE, ni rama de arriba, ni origin/main, ni main)');
  else {
    const d = spawnSync('git', ['diff', '-U0', base, '--', 'scripts/tests/operations-github-workflows.test.js', 'scripts/tests/open-pr-per-finding-github.test.sh'], { cwd: ROOT, encoding: 'utf8' });
    const cambiadas = d.stdout.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    assert.ok(cambiadas.length <= 4 && cambiadas.filter((l) => l.startsWith('+')).every((l) => l.includes('HARNESS_SOURCE_CREDENTIALS')), `sólo la lista de secretos:\n${cambiadas.join('\n')}`);
    assert.ok(!d.stdout.includes('open-pr-per-finding-github.test.sh'), 'la prueba de bash no cambia');
  }
});

// ── el conector de GitLab ────────────────────────────────────────────────────────────────────────────────────────────

test('T9 Gitlab_ListaConSubgruposYPaginas @story-1.6 @ac-6', async () => {
  const lab = await gitlab({ grupos: { acme: [
    [proyecto('acme', 'web'), proyecto('acme/sub', 'api')],
    [proyecto('acme', 'viejo', true), proyecto('acme/sub/hondo', 'lib')],
    [proyecto('acme', 'docs')],
  ] } });
  const m = mundo();
  const r = await capa(m, 'repos.list', { source: GL_SRC(lab.port), credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port) });
  const v = resultado(r.out);
  assert.strictEqual(v.ok, true, r.all);
  // el archivado viene marcado: el núcleo no lo clona ni lo da por faltante
  assert.deepStrictEqual(v.value.filter((x) => !x.archived).map((x) => x.id).sort(), ['acme/docs', 'acme/sub/api', 'acme/sub/hondo/lib', 'acme/web']);
  assert.deepStrictEqual(v.value.filter((x) => x.archived).map((x) => x.id), ['acme/viejo']);
  const api = lab.pedidos.filter((p) => p.path.startsWith('/api/v4/'));
  assert.strictEqual(api.length, 3, 'las tres páginas');
  for (const p of api) {
    assert.match(p.query, /include_subgroups=true/); assert.doesNotMatch(p.query, /archived=/); assert.match(p.query, /per_page=100/);
    assert.strictEqual(p.headers['private-token'], TOKEN);
  }
});

test('T10 Gitlab_PatronesLosPoneElNucleo @story-1.6 @ac-6', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n', 'docs/a.md': 'a\n', '.tycon/x.json': '{}\n', '.advisors/y.md': 'y\n', 'src/app.js': 'x\n' });
  const lab = await gitlab({ repos });
  const m = mundo();
  const env = { TYCON_GITLAB_PORT: String(lab.port) };
  // sólo el Markdown, si eso es lo que pide el núcleo
  const d1 = path.join(tmp('clon-'), 'w');
  let r = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/web', dest: d1, sparse: ['**/*.md'], credential: TOKEN }, env)).out);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(d1, 'docs', 'a.md')) && !fs.existsSync(path.join(d1, '.tycon')) && !fs.existsSync(path.join(d1, 'src')));
  // con los patrones del clon liviano del núcleo: Markdown, .advisors/ y .tycon/
  const { LIGHT_PATTERNS } = require(SOURCES);
  assert.deepStrictEqual(LIGHT_PATTERNS, ['**/*.md', '.advisors/**', '.tycon/**']);
  const d2 = path.join(tmp('clon-'), 'w');
  r = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/web', dest: d2, sparse: LIGHT_PATTERNS, credential: TOKEN }, env)).out);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(d2, '.tycon', 'x.json')) && fs.existsSync(path.join(d2, '.advisors', 'y.md')) && !fs.existsSync(path.join(d2, 'src', 'app.js')));
  assert.doesNotMatch(fs.readFileSync(path.join(d2, '.git', 'config'), 'utf8'), /extraheader|oauth2|glpat/i);
});

test('T11 Gitlab_ClonCompletoSinToken @story-1.6 @ac-6', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/api', { 'api.sln': '\n', 'README.md': '# a\n' });
  const lab = await gitlab({ repos });
  const m = mundo();
  const dest = path.join(tmp('clon-'), 'api');
  const out = await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/api', dest, depth: 1, credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port) });
  const r = resultado(out.out);
  assert.strictEqual(r.ok, true, out.all);
  assert.ok(fs.existsSync(path.join(dest, 'api.sln')));
  assert.strictEqual(git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  assert.strictEqual(git(dest, ['rev-list', '--count', 'HEAD']).trim(), '1', 'profundidad 1');
  const cfg = fs.readFileSync(path.join(dest, '.git', 'config'), 'utf8');
  assert.doesNotMatch(cfg, new RegExp(`extraheader|${TOKEN}|${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`, 'i'));
});

// ── el paso común: carpetas, índice, estado ──────────────────────────────────────────────────────────────────────────

/** Corre `sources.js clone` con las fuentes, los servidores y el secreto que se pasen. */
async function noche(m, { sources, creds, port, extraEnv = {}, reposJson = null, dashboard = null, teamRepos = m.teamRepos }) {
  const base = tmp('noche-');
  const f = operations(base, sources);
  const dest = path.join(base, 'repos');
  const dash = dashboard || path.join(base, '.dashboard');
  const args = [SOURCES, 'clone', '--dir', dest, '--operations', f, '--team-repos', teamRepos, '--dashboard', dash, '--today', '2026-11-27'];
  if (reposJson) args.push('--repos-json', reposJson);
  const env = { ...m.env, ...extraEnv };
  if (port) env.TYCON_GITLAB_PORT = String(port);
  if (creds !== undefined) env.HARNESS_SOURCE_CREDENTIALS = typeof creds === 'string' ? creds : JSON.stringify(creds);
  const r = await run(process.execPath, args, { env, cwd: base });
  const estadoFile = path.join(dash, 'nightly-sources-2026-11-27.json');
  const estado = fs.existsSync(estadoFile) ? JSON.parse(fs.readFileSync(estadoFile, 'utf8')) : null;
  const indexFile = path.join(dest, 'sources-index.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : null;
  return { ...r, base, dest, estado, index };
}
const fuente = (estado, re) => estado.fuentes.find((x) => re.test(x.fuente));

test('T12 Carpetas_SinChoqueEIndice @story-1.6 @ac-7', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# gl\n' });
  repoBare(repos, 'a__b/web', { 'README.md': '# ab\n' });
  repoBare(repos, 'a__b/api', { 'README.md': '# ab2\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]], a__b: [[proyecto('a__b', 'web'), proyecto('a__b', 'api')]] } });
  const m = mundo();
  const gh = githubLab(tmp('gh-lab-'), ['web']);
  const r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN },
    sources: [{ platform: 'github', org: 'acme' }, GL_SRC(lab.port, 'acme'), GL_SRC(lab.port, 'a__b')],
    extraEnv: { ORG_TOKEN: GH_TOKEN, ORG_TOKEN_KIND: 'user', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: gh.state, GITHUB_SERVER_URL: `file://${gh.server}` } });
  assert.strictEqual(r.code, 0, r.all);
  const carpetas = fs.readdirSync(r.dest).filter((x) => x !== 'sources-index.json').sort();
  assert.strictEqual(carpetas.length, 4, carpetas.join(' '));
  assert.ok(carpetas.includes('acme__web'), 'GitHub conserva <dueño>__<repo>');
  const otras = carpetas.filter((x) => x !== 'acme__web');
  for (const c of otras) assert.doesNotMatch(c, /__/, `${c}: sin «__» en las carpetas que no son de la noche`);
  assert.strictEqual(new Set(carpetas).size, 4);
  // el índice: carpeta → fuente, con el grupo de los hermanos
  for (const c of carpetas) assert.ok(r.index[c] && r.index[c].source && r.index[c].group, `${c} en el índice`);
  const grupoDe = (c) => r.index[c].group;
  const ab = otras.filter((c) => /a__b|a_b/.test(r.index[c].id));
  assert.strictEqual(ab.length, 2); assert.strictEqual(grupoDe(ab[0]), grupoDe(ab[1]));
  assert.notStrictEqual(grupoDe('acme__web'), grupoDe(otras.find((c) => r.index[c].id === 'acme/web')), 'acme de GitHub no es hermano de acme de GitLab');
  // las métricas agrupan los hermanos por el índice, nunca cortando en __
  for (const c of carpetas) { fs.mkdirSync(path.join(r.dest, c, '.advisors', 'dod-runtime'), { recursive: true }); }
  const { dirsDeEvidencia } = require(path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
  const hermanos = dirsDeEvidencia(path.join(r.dest, ab[0])).map((d) => path.basename(path.dirname(path.dirname(d))));
  assert.deepStrictEqual(hermanos.sort(), [...ab].sort());
  const solo = dirsDeEvidencia(path.join(r.dest, 'acme__web')).map((d) => path.basename(path.dirname(path.dirname(d))));
  assert.deepStrictEqual(solo, ['acme__web']);
});

// ── la revisión de dependencias y la paridad ─────────────────────────────────────────────────────────────────────────

test('T13 Dependencias_FuenteGitlabPorLaCapa @story-1.6 @ac-8', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/back', { 'package.json': '{"name":"back"}\n' });
  const lab = await gitlab({ repos });
  const m = mundo();
  const cfgDir = tmp('deps-');
  const cfgFile = path.join(cfgDir, 'repos.json');
  const SRC = { platform: 'gitlab', host: 'localhost', namespace: 'acme', repo: 'back' };
  fs.writeFileSync(cfgFile, JSON.stringify({ repos: [
    { producto: 'Acme', ruta: 'Acme/back', tipo: 'npm', source: SRC },
    { producto: 'Acme', ruta: 'Acme/web', tipo: 'npm', github: 'acme/web' },
  ] }));
  const ND = path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'nightly-dependencies.js');
  // la lista de siempre no cambia ni nombra la fuente; la de fuentes trae sólo la entrada con source
  const lista = spawnSync(process.execPath, [ND, 'clone-list', '--config', cfgFile], { encoding: 'utf8' });
  assert.strictEqual(lista.status, 0, lista.stderr);
  assert.strictEqual(lista.stdout, 'Acme/web\tacme/web\n');
  const fuentes = spawnSync(process.execPath, [ND, 'clone-list', '--sources', '--config', cfgFile], { encoding: 'utf8' });
  assert.strictEqual(fuentes.status, 0, fuentes.stderr);
  const [ruta, json] = fuentes.stdout.trim().split('\t');
  assert.strictEqual(ruta, 'Acme/back'); assert.deepStrictEqual(JSON.parse(json), SRC);
  // una entrada source mal escrita se valida con el lector de team-repos
  fs.writeFileSync(path.join(cfgDir, 'malo.json'), JSON.stringify({ repos: [{ producto: 'A', ruta: 'A/b', tipo: 'npm', source: { platform: 'gitlab', namespace: 'acme' } }] }));
  const mala = spawnSync(process.execPath, [ND, 'clone-list', '--sources', '--config', path.join(cfgDir, 'malo.json')], { encoding: 'utf8' });
  assert.strictEqual(mala.stdout, ''); assert.match(mala.stderr, /repos\[0\]\.source\.repo/);
  // el clon se le pide a la capa
  const dest = tmp('clones-');
  const c = await run(process.execPath, [SOURCES, 'clone-declared', dest], { input: fuentes.stdout,
    env: { ...m.env, TYCON_GITLAB_PORT: String(lab.port), HARNESS_SOURCE_CREDENTIALS: JSON.stringify({ gitlab: TOKEN }) } });
  assert.strictEqual(c.code, 0, c.all);
  assert.ok(fs.existsSync(path.join(dest, 'Acme', 'back', 'package.json')), c.all);
  assert.doesNotMatch(fs.readFileSync(path.join(dest, 'Acme', 'back', '.git', 'config'), 'utf8'), /extraheader/i);
  // el hallazgo llega a la ficha (pedido de decisión), el issue no se crea y la corrida lo dice
  const NDm = require(ND);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.strictEqual(NDm.proyectoDe('Acme/back', cfg), 'Acme', 'la ficha tiene su proyecto');
  assert.strictEqual(require(path.join(ROOT, 'scripts', 'lib', 'dependency-project.js')).declaredProject('Acme/back', cfg), null, 'sin issue por hallazgo');
  const avisos = NDm.fuentesSinAviso(cfg);
  assert.strictEqual(avisos.length, 1); assert.match(avisos[0], /Acme\/back[^\n]*issue[^\n]*no se crea/);
  // la paridad: no clona la entrada de la fuente y la deja no medida
  const PAR = path.join(ROOT, 'scripts', 'ci', 'check-product-parity.js');
  const pcfg = path.join(cfgDir, 'parity.json');
  fs.writeFileSync(pcfg, JSON.stringify({ rasgos: [{ id: 'r', archivo: 'azure-pipelines.yml', patron: 'x' }], grupos: { back: { repos: [{ ruta: 'Acme/back', source: SRC }, { ruta: 'Acme/web', github: 'acme/web' }] } } }));
  const pl = spawnSync(process.execPath, [PAR, 'clone-list', '--root', tmp('raiz-'), '--config', pcfg, '--platform', 'github'], { encoding: 'utf8' });
  assert.strictEqual(pl.status, 0, pl.stderr);
  assert.strictEqual(pl.stdout, 'Acme/web\tacme/web\n');
  assert.match(pl.stderr, /Acme\/back[^\n]*no medido/);
});

// ── el tablero ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('T14 Tablero_EstadoPorFuente @story-1.6 @ac-9', () => {
  const D = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'));
  const doc = { fecha: '2026-11-27', fuentes: [
    { fuente: 'github:acme', platform: 'github', estado: 'medida', motivo: null, detalle: null, repos: 3, faltan: [], fallidos: [] },
    { fuente: 'gitlab:gitlab.example.com/acme', platform: 'gitlab', estado: 'no_medida', motivo: 'rechazado', detalle: 'la credencial fue rechazada: renovalo', repos: 0, faltan: [], fallidos: [] },
  ] };
  const f = D.fichaFuentes(doc, '2026-11-27');
  assert.strictEqual(f.estado, 'medido');
  assert.strictEqual(f.fuentes.length, 2);
  const html = D.filasFuentes(f);
  assert.match(html, /github:acme[\s\S]*medida/);
  assert.match(html, /gitlab:gitlab\.example\.com\/acme[\s\S]*no medida[\s\S]*rechazado[\s\S]*renovalo/);
  assert.strictEqual(D.fichaFuentes(null, '2026-11-27').estado, 'no_medido');
  // los despliegues de un producto cuya plataforma no los lee: no medido, sin error
  const foto = { generado: '2026-11-27T05:00:00Z', productos: { Web: { estado: 'medido', produccion_atrasada: false } } };
  const dep = D.fichaDespliegues(foto, '2026-11-27', { sinLector: ['Acme GitLab'] });
  assert.strictEqual(dep.estado, 'medido');
  assert.match(dep.detalle, /Acme GitLab[^·]*no medido/);
  assert.ok(D.productosSinLectorDeDespliegues, 'el tablero sabe qué productos no tienen lector');
  const sin = D.productosSinLectorDeDespliegues([{ producto: 'Acme GitLab', source: { platform: 'gitlab', namespace: 'a', repo: 'b' } }, { producto: 'Web', github: 'acme/web' }]);
  assert.deepStrictEqual(sin, ['Acme GitLab']);
});

// ── el secreto ───────────────────────────────────────────────────────────────────────────────────────────────────────

const yml = (n) => fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'github', n), 'utf8');
/** Los pasos de un workflow, cada uno con su texto. */
const pasos = (t) => t.split(/\n(?= {6}- )/).slice(1);

test('T15 Secreto_SoloEnElPasoQueClona @story-1.6 @ac-10', () => {
  const SEC = /HARNESS_SOURCE_CREDENTIALS/;
  for (const [n, re] of [['stage-metrics.yml', /clone-repos\.sh --org/], ['dependency-audit.yml', /clone-repos\.sh --declared/]]) {
    const t = yml(n);
    const con = pasos(t).filter((s) => SEC.test(s));
    assert.strictEqual(con.length, 1, `${n}: el secreto en un solo paso`);
    assert.match(con[0], re, `${n}: el paso que lista y clona`);
    assert.match(con[0], /^ {10}HARNESS_SOURCE_CREDENTIALS: \$\{\{ secrets\.HARNESS_SOURCE_CREDENTIALS \}\}$/m, `${n}: en el env: del paso`);
    // nunca en el env de un trabajo ni en el paso que corre código de los productos
    const fuera = t.split('\n').filter((l) => SEC.test(l) && !/^ {10}HARNESS_SOURCE_CREDENTIALS:/.test(l) && !/^\s*#/.test(l));
    assert.deepStrictEqual(fuera, [], `${n}: fuera del env del paso`);
    for (const s of pasos(t).filter((x) => /dotnet restore|nightly-dependencies\.js run/.test(x))) assert.doesNotMatch(s, SEC);
  }
  assert.doesNotMatch(yml('team-dashboard.yml'), SEC, 'el tablero no lo recibe');
});

test('T16 Secreto_MascaraYJsonMalEscrito @story-1.6 @ac-10', async () => {
  const S = require(SOURCES);
  const out = [];
  const creds = S.readCredentials(JSON.stringify({ gitlab: TOKEN, github: GH_TOKEN }), (l) => out.push(l));
  assert.deepStrictEqual(creds, { gitlab: TOKEN, github: GH_TOKEN });
  assert.deepStrictEqual(out, [`::add-mask::${TOKEN}`, `::add-mask::${GH_TOKEN}`]);
  const out2 = [];
  const malo = `{"gitlab": "${TOKEN}"`;
  assert.deepStrictEqual(S.readCredentials(malo, (l) => out2.push(l)), {});
  assert.ok(out2.some((l) => /::error::[^\n]*HARNESS_SOURCE_CREDENTIALS[^\n]*no es un JSON/.test(l)), out2.join('\n'));
  assert.ok(!out2.join('\n').includes(TOKEN), 'el error no muestra el texto');
  // el conector enmascara su cabecera en la salida del paso antes de usarla
  const lab = await gitlab({ grupos: { acme: [[proyecto('acme', 'web')]] } });
  const r = await capa(mundo(), 'repos.list', { source: GL_SRC(lab.port), credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port) });
  assert.match(r.out, /^::add-mask::/m);
});

test('T17 Nucleo_SinNombresNuevos @story-1.6 @ac-11', (t) => {
  const { core } = require(path.join(ROOT, 'scripts', 'ci', 'check-core-neutrality.js'));
  // los nombres de plataforma: los de los manifiestos de los conectores de plataforma
  const names = fs.readdirSync(path.join(ROOT, 'integrations')).map((n) => {
    try { const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', n, 'integration.json'), 'utf8')); return m.kind === 'platform' ? m.name : null; } catch (_) { return null; }
  }).filter(Boolean);
  assert.ok(names.includes('gitlab') && names.includes('github'));
  const lab = (archivo, linea) => `diff --git a/${archivo} b/${archivo}\n--- a/${archivo}\n+++ b/${archivo}\n@@ -1,0 +1,1 @@\n+${linea}\n`;
  assert.deepStrictEqual(nombresNuevos(lab('scripts/lib/x.js', "const p = 'gitlab';"), names, core).map((x) => x.archivo), ['scripts/lib/x.js']);
  assert.deepStrictEqual(nombresNuevos(lab('guides/integrations/x.md', 'GitLab y GitHub'), names, core), []);
  // el diff real de la historia
  const real = diffReal();
  // sin base no hay diff que mirar: no medido, nunca verde
  if (real === null) { t.skip('no medido: no hay base para el diff (ni TYCON_DIFF_BASE, ni rama de arriba, ni origin/main, ni main)'); return; }
  const malos = nombresNuevos(real, names, core);
  assert.deepStrictEqual(malos, [], malos.map((x) => `${x.archivo}: ${x.linea}`).join('\n'));
  const neutral = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', 'check-core-neutrality.js'), '--repo', ROOT], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(neutral.status, 0, neutral.stdout + neutral.stderr);
});

// ── modos de falla ───────────────────────────────────────────────────────────────────────────────────────────────────

test('T18 Registro_SinToken @story-1.6 @ac-12', async () => {
  const repos = tmp('gl-repos-');
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'nope')]] } });
  const m = mundo();
  const b64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
  const casos = [
    await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)] }),
    await noche(m, { port: lab.port, creds: { gitlab: 'otro-token-que-no-va' }, sources: [GL_SRC(lab.port)] }),
    await noche(m, { port: lab.port, creds: `{"gitlab": "${TOKEN}"`, sources: [GL_SRC(lab.port)] }),
  ];
  for (const [i, r] of casos.entries()) {
    assert.strictEqual(r.code, 0, r.all);
    const lineas = r.all.split('\n');
    const fuera = lineas.filter((l) => !l.startsWith('::add-mask::'));
    for (const secreto of [TOKEN, b64, 'otro-token-que-no-va']) assert.ok(!fuera.some((l) => l.includes(secreto)), `caso ${i}: el registro no trae ${secreto.slice(0, 5)}…`);
    if (i === 0) {
      const mascaras = lineas.map((l, j) => [l, j]).filter(([l]) => l.startsWith('::add-mask::'));
      assert.ok(mascaras.some(([l]) => l === `::add-mask::${TOKEN}`) && mascaras.some(([l]) => l.includes(b64)), 'el token y la cabecera enmascarados');
      const primerUso = lineas.findIndex((l) => /acme\/nope|clon/i.test(l) && !l.startsWith('::add-mask::'));
      assert.ok(mascaras.every(([, j]) => primerUso < 0 || j < primerUso), 'las máscaras antes del primer uso');
    }
  }
});

test('T19 Falla_FuenteNoMedidaConMotivo @story-1.6 @ac-13', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'mitad/bien', { 'README.md': '# b\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]], vacio: [[]], mitad: [[proyecto('mitad', 'bien'), proyecto('mitad', 'mal')]] } });
  const prohibido = await gitlab({ grupos: { acme: [[proyecto('acme', 'web')]] }, falla: { todo: 403 } });
  const m = mundo();
  const gh = githubLab(tmp('gh-lab-'), ['web']);
  const ghEnv = { ORG_TOKEN: GH_TOKEN, ORG_TOKEN_KIND: 'user', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: gh.state, GITHUB_SERVER_URL: `file://${gh.server}` };
  const con = (port, creds, src) => noche(m, { port, creds, sources: [{ platform: 'github', org: 'acme' }, src], extraEnv: ghEnv });
  const casos = [
    [await con(lab.port, {}, GL_SRC(lab.port)), 'sin_credencial', /cargá el token/],
    [await con(lab.port, { gitlab: 'malo' }, GL_SRC(lab.port)), 'rechazado', /renovalo/],
    [await con(prohibido.port, { gitlab: TOKEN }, GL_SRC(prohibido.port)), 'rechazado', /renovalo/],
    [await con(lab.port, { gitlab: TOKEN }, GL_SRC(lab.port, 'no-existe')), 'no_encontrado', /no-existe/],
    [await con(lab.port, { gitlab: TOKEN }, GL_SRC(lab.port, 'vacio')), 'no_medido', /ningún repo/],
  ];
  for (const [r, motivo, texto] of casos) {
    assert.strictEqual(r.code, 0, r.all);
    const gl = fuente(r.estado, /gitlab/);
    assert.strictEqual(gl.estado, 'no_medida', JSON.stringify(gl)); assert.strictEqual(gl.motivo, motivo, JSON.stringify(gl));
    assert.match(`${gl.detalle}`, texto);
    assert.match(r.out, new RegExp(`::warning::[^\\n]*${gl.fuente.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'el aviso nombra la fuente');
    assert.strictEqual(fuente(r.estado, /github/).estado, 'medida', 'las demás se miden igual');
    assert.ok(fs.existsSync(path.join(r.dest, 'acme__web')));
  }
  // un repo que no se clona: la fuente medida en parte, el clonado medido y el fallido nombrado
  const r = await con(lab.port, { gitlab: TOKEN }, GL_SRC(lab.port, 'mitad'));
  const gl = fuente(r.estado, /gitlab/);
  assert.strictEqual(gl.estado, 'en_parte', JSON.stringify(gl));
  assert.deepStrictEqual(gl.fallidos.map((x) => x.id), ['mitad/mal']);
  assert.ok(Object.values(r.index).some((x) => x.id === 'mitad/bien'), 'el clonado entra a las métricas');
  assert.match(r.out, /::warning::[^\n]*mitad\/mal/);
});

test('T20 Falla_TokenVeMenosQueLoDeclarado @story-1.6 @ac-14', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]] } });
  const m = mundo();
  const rj = path.join(tmp('rj-'), 'repos.json');
  fs.writeFileSync(rj, JSON.stringify({ repos: [
    { producto: 'A', ruta: 'A/web', tipo: 'npm', source: { platform: 'gitlab', host: 'localhost', namespace: 'acme', repo: 'web' } },
    { producto: 'A', ruta: 'A/oculto', tipo: 'npm', source: { platform: 'gitlab', host: 'localhost', namespace: 'acme', repo: 'oculto' } },
  ] }));
  const r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)], reposJson: rj });
  assert.strictEqual(r.code, 0, r.all);
  const gl = fuente(r.estado, /gitlab/);
  assert.strictEqual(gl.estado, 'en_parte');
  assert.deepStrictEqual(gl.faltan, ['acme/oculto']);
  assert.match(r.out, /::warning::[^\n]*acme\/oculto/);
});

test('T21 Falla_NoSoportadoYAzure @story-1.6 @ac-15', async () => {
  const m = mundo();
  const r = await noche(m, { creds: {}, sources: [{ platform: 'azure', org: 'acme', project: 'Producto' }] });
  assert.strictEqual(r.code, 0, r.all);
  const az = r.estado.fuentes[0];
  assert.strictEqual(az.estado, 'no_medida'); assert.strictEqual(az.motivo, 'no_soportado');
  assert.match(r.out, /::warning::[^\n]*azure:acme\/Producto[^\n]*no la mide/);
  // la noche de Azure DevOps con nightly.sources: lo avisa nombrando cada fuente
  const f = operations(tmp('ops-'), [{ platform: 'gitlab', namespace: 'acme' }, { platform: 'github', org: 'acme' }]);
  const v = await run(process.execPath, [SOURCES, 'skipped', '--operations', f, '--format', 'vso'], { env: m.env });
  assert.strictEqual(v.code, 0, v.all);
  assert.match(v.out, /##vso\[task\.logissue type=warning\][^\n]*gitlab:acme[^\n]*no la mide/);
  assert.match(v.out, /##vso\[task\.logissue type=warning\][^\n]*github:acme/);
  assert.match(fs.readFileSync(path.join(ROOT, 'pipelines', 'operations', 'templates', 'ops-data.yml'), 'utf8'), /sources\.js"? skipped --operations/);
});

test('T22 Guias_GitlabNocheYConectores @story-1.6 @ac-16', () => {
  const leer = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const gl = leer('guides/integrations/gitlab-platform.md');
  const pendiente = (gl.split(/^## /m).find((s) => /^Lo que todavía no atiende/.test(s)) || '');
  assert.doesNotMatch(pendiente, /noche|nocturn/i, 'la noche ya no figura como pendiente');
  assert.match(gl, /nightly\.sources/);
  const rd = leer('pipelines/operations/github/README.md');
  assert.match(rd, /nightly\.sources/); assert.match(rd, /read_api/); assert.match(rd, /read_repository/); assert.match(rd, /HARNESS_SOURCE_CREDENTIALS/);
  assert.match(rd, /todavía no/i);
  const pc = leer('guides/integrations/platform-connectors.md');
  assert.match(pc, /repos\.list/); assert.match(pc, /repos\.clone/);
  const ej = JSON.parse(leer('pipelines/operations/examples/operations.json'));
  assert.ok(ej.nightly && Array.isArray(ej.nightly.sources) && ej.nightly.sources.length, 'el ejemplo trae la sección');
  assert.strictEqual(OC().parse(JSON.stringify(ej)).sectionProblems, undefined, 'el ejemplo valida');
});

test('T23 Gitlab_RedireccionNoLlevaElToken @story-1.6 @ac-17', async () => {
  const otro = await gitlab({ grupos: { acme: [[proyecto('acme', 'web')]] }, repos: tmp('otro-') });
  const lab = await gitlab({ redirige: otro.url });
  const m = mundo();
  const env = { TYCON_GITLAB_PORT: String(lab.port) };
  const l = resultado((await capa(m, 'repos.list', { source: GL_SRC(lab.port), credential: TOKEN }, env)).out);
  assert.strictEqual(l.ok, false); assert.strictEqual(l.reason, 'no_medido'); assert.match(l.detail, /redirig/);
  const c = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/web', dest: path.join(tmp('c-'), 'w'), depth: 1, credential: TOKEN }, env)).out);
  assert.strictEqual(c.ok, false, JSON.stringify(c));
  assert.ok(lab.pedidos.length >= 2, 'el primero sí recibió los pedidos');
  assert.strictEqual(otro.pedidos.length, 0, 'el otro servidor no recibe nada: ni PRIVATE-TOKEN ni la cabecera del clon');
});

test('T24 Gitlab_PaginaRotaOTopeNoAchica @story-1.6 @ac-18', async () => {
  const tres = { acme: [[proyecto('acme', 'a')], [proyecto('acme', 'b')], [proyecto('acme', 'c')]] };
  const m = mundo();
  const rota = await gitlab({ grupos: tres, falla: { 2: 500 } });
  let r = resultado((await capa(m, 'repos.list', { source: GL_SRC(rota.port), credential: TOKEN }, { TYCON_GITLAB_PORT: String(rota.port) })).out);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'no_medido'); assert.match(r.detail, /página 2/);
  const sana = await gitlab({ grupos: tres });
  r = resultado((await capa(m, 'repos.list', { source: GL_SRC(sana.port), credential: TOKEN }, { TYCON_GITLAB_PORT: String(sana.port), TYCON_GITLAB_MAX_PAGES: '2' })).out);
  assert.strictEqual(r.ok, false); assert.match(r.detail, /tope de 2 páginas/);
  const lenta = await gitlab({ grupos: tres, demora: 300 });
  r = resultado((await capa(m, 'repos.list', { source: GL_SRC(lenta.port), credential: TOKEN }, { TYCON_GITLAB_PORT: String(lenta.port), TYCON_GITLAB_DEADLINE_MS: '400' })).out);
  assert.strictEqual(r.ok, false); assert.match(r.detail, /tope de tiempo/);
  // por sources.js: la fuente no medida, ninguna lista parcial llega a las métricas
  const n = await noche(m, { port: rota.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(rota.port)] });
  assert.strictEqual(fuente(n.estado, /gitlab/).estado, 'no_medida');
  assert.deepStrictEqual(Object.keys(n.index || {}), []);
});

test('T25 Secreto_NoLlegaAlConector @story-1.6 @ac-10', () => {
  const S = require(SOURCES);
  // cada conector recibe sólo su credencial (args.credential): el secreto con las de todas las plataformas no viaja en
  // el entorno que la capa le pasa, ni al git que el conector lanza
  const env = { PATH: '/bin', HARNESS_SOURCE_CREDENTIALS: JSON.stringify({ gitlab: TOKEN, github: GH_TOKEN }), OTRA: 'x' };
  const limpio = S.connectorEnv(env);
  assert.deepStrictEqual(limpio, { PATH: '/bin', OTRA: 'x' });
  assert.ok('HARNESS_SOURCE_CREDENTIALS' in env, 'no toca el entorno del paso');
  const src = fs.readFileSync(SOURCES, 'utf8');
  const llamadas = src.match(/P\.run\([^\n]*/g) || [];
  assert.ok(llamadas.length >= 3, 'las llamadas a la capa están');
  for (const l of llamadas) assert.match(l, /\{ env: envConector \}\)/, `toda llamada a la capa pasa el entorno sin el secreto: ${l}`);
});

test('T26 Falla_ConfiguracionIlegibleAvisa @story-1.6 @ac-13', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]] } });
  const m = mundo();
  const roto = (n) => { const f = path.join(tmp('roto-'), n); fs.writeFileSync(f, '{ no es json'); return f; };
  // team-repos.json ilegible: la noche mide igual y dice qué dejó de verificar
  let r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)], teamRepos: roto('team-repos.json') });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(fuente(r.estado, /gitlab/).estado, 'medida');
  assert.match(r.out, /::warning::[^\n]*team-repos\.json[^\n]*copias del arnés/);
  // repos.json ilegible: lo mismo, con el cruce de los declarados
  r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)], reposJson: roto('repos.json') });
  assert.strictEqual(r.code, 0, r.all);
  assert.match(r.out, /::warning::[^\n]*repos\.json[^\n]*declarados/);
  // operations.json ilegible: `declared` lo dice y la noche sigue con lo de hoy
  const d = await run(process.execPath, [SOURCES, 'declared', '--operations', roto('operations.json')], { env: m.env });
  assert.strictEqual(d.code, 1, d.all);
  assert.match(d.out, /::warning::[^\n]*operations\.json[^\n]*lo de hoy/);
  // sin operations.json, no avisa: no hay fuentes que dejar de medir
  const sin = await run(process.execPath, [SOURCES, 'declared', '--operations', path.join(tmp('sin-'), 'operations.json')], { env: m.env });
  assert.strictEqual(sin.code, 1, sin.all);
  assert.doesNotMatch(sin.out, /::warning::/);
});

test('T27 Noche_CruzaReposJsonEnProduccion @story-1.6 @ac-14', async () => {
  // el camino real de la noche (clone-repos.sh, como lo llama stage-metrics) cruza contra repos.json del árbol
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]] } });
  const m = mundo();
  const base = tmp('arbol-noche-');
  operations(base, [GL_SRC(lab.port)]);
  write(base, { 'scripts/nightly/dependencies/repos.json': JSON.stringify({ repos: [
    { producto: 'A', ruta: 'A/oculto', tipo: 'npm', source: { platform: 'gitlab', host: 'localhost', namespace: 'acme', repo: 'oculto' } },
  ] }) });
  const r = await run('bash', [path.join(ROOT, 'pipelines', 'operations', 'github', 'clone-repos.sh'), '--org', path.join(base, 'repos'), '--team-repos', m.teamRepos],
    { cwd: base, env: { ...m.env, TYCON_GITLAB_PORT: String(lab.port), HARNESS_SOURCE_CREDENTIALS: JSON.stringify({ gitlab: TOKEN }), DASHBOARD_DIR: path.join(base, '.dashboard') } });
  assert.strictEqual(r.code, 0, r.all);
  const estado = JSON.parse(fs.readFileSync(fs.readdirSync(path.join(base, '.dashboard')).map((f) => path.join(base, '.dashboard', f))[0], 'utf8'));
  const gl = fuente(estado, /gitlab/);
  assert.strictEqual(gl.estado, 'en_parte', JSON.stringify(gl));
  assert.deepStrictEqual(gl.faltan, ['acme/oculto']);
});

test('T28 Declarados_HostPorDefectoEsElMismoServidor @story-1.6 @ac-14', () => {
  const S = require(SOURCES);
  const sinHost = { platform: 'gitlab', namespace: 'acme' };
  const conHost = { platform: 'gitlab', host: 'gitlab.com', namespace: 'acme' };
  const decl = (host) => ({ platform: 'gitlab', ...(host ? { host } : {}), namespace: 'acme', repo: 'oculto' });
  // sin host es el servidor por defecto de su conector: lo mismo que nombrarlo
  assert.deepStrictEqual(S.declaredFor(sinHost, [decl('gitlab.com')]), ['acme/oculto']);
  assert.deepStrictEqual(S.declaredFor(conHost, [decl(null)]), ['acme/oculto']);
  assert.deepStrictEqual(S.declaredFor(conHost, [decl('GitLab.com')]), ['acme/oculto']);
  // otro servidor es otra fuente
  assert.deepStrictEqual(S.declaredFor(sinHost, [decl('gitlab.example.com')]), []);
});

test('T29 Fuentes_AnidadasNoRepitenRepos @story-1.6 @ac-7', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  repoBare(repos, 'acme/sub/web', { 'README.md': '# s\n' });
  // como la API con include_subgroups=true: el grupo trae los repos de sus subgrupos
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web'), proyecto('acme/sub', 'web')]], 'acme/sub': [[proyecto('acme/sub', 'web')]] } });
  const m = mundo();
  const sub = { ...GL_SRC(lab.port), namespace: 'acme/sub' };
  const ida = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port), sub] });
  const vuelta = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [sub, GL_SRC(lab.port)] });
  for (const r of [ida, vuelta]) {
    assert.strictEqual(r.code, 0, r.all);
    const ids = Object.values(r.index).map((x) => x.id).sort();
    assert.deepStrictEqual(ids, ['acme/sub/web', 'acme/web'], 'cada repo una sola vez');
    assert.match(r.out, /repos clonados: 2/);
    assert.match(r.out, /::warning::[^\n]*acme\/sub\/web[^\n]*ya lo trajo/);
  }
  // la carpeta de cada repo no depende del orden de las fuentes
  assert.deepStrictEqual(Object.keys(ida.index).sort(), Object.keys(vuelta.index).sort());
});

test('T30 Github_TokenDeLaFuenteAveriguaSuTipo @story-1.6 @ac-5', async () => {
  // ORG_TOKEN_KIND describe ORG_TOKEN (la App de la organización), no el token de la fuente
  const m = mundo();
  const gh = githubLab(tmp('gh-lab-'), ['web']);
  const ghEnv = { ORG_TOKEN: 'token-de-la-app', ORG_TOKEN_KIND: 'app', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: gh.state, GITHUB_SERVER_URL: `file://${gh.server}` };
  const r = await noche(m, { creds: { github: GH_TOKEN }, sources: [{ platform: 'github', org: 'acme' }], extraEnv: ghEnv });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(fuente(r.estado, /github/).estado, 'medida', JSON.stringify(r.estado));
  assert.ok(fs.existsSync(path.join(r.dest, 'acme__web')));
});

test('T31 Declarados_ApagadosYArchivadosNoFaltan @story-1.6 @ac-14', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web'), proyecto('acme', 'viejo', true)]] } });
  const m = mundo();
  const rj = path.join(tmp('rj-'), 'repos.json');
  const src = (repo) => ({ platform: 'gitlab', host: 'localhost', namespace: 'acme', repo });
  fs.writeFileSync(rj, JSON.stringify({ repos: [
    { producto: 'A', ruta: 'A/web', tipo: 'npm', source: src('web') },
    { producto: 'A', ruta: 'A/apagado', tipo: 'npm', activo: false, motivo: 'se dio de baja', source: src('apagado') },
    { producto: 'A', ruta: 'A/viejo', tipo: 'npm', source: src('viejo') },
  ] }));
  const r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)], reposJson: rj });
  assert.strictEqual(r.code, 0, r.all);
  const gl = fuente(r.estado, /gitlab/);
  // apagado a propósito: no se espera; archivado: la fuente lo devolvió, no se clona y no falta
  assert.strictEqual(gl.estado, 'medida', JSON.stringify(gl));
  assert.deepStrictEqual(gl.faltan, []);
  assert.ok(!Object.values(r.index).some((x) => x.id === 'acme/viejo'), 'el archivado no se clona');
});

/** Un servidor https de laboratorio que contesta lo que diga `contesta(req, res)`. Devuelve su puerto. */
async function crudo(contesta) {
  const c = cert();
  const server = https.createServer({ key: c.key, cert: c.cert }, contesta);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return server.address().port;
}

/** Un puerto donde no escucha nadie. */
async function puertoCerrado() {
  const s = require('net').createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test('T32 Gitlab_ListaQueNoSeEntiendeNoSeMide @story-1.6 @ac-13', async () => {
  const m = mundo();
  const lista = async (port, extra = {}, source = GL_SRC(port)) =>
    resultado((await capa(m, 'repos.list', { source, credential: TOKEN }, { TYCON_GITLAB_PORT: String(port), ...extra })).out);
  const contesta = (body, headers = {}) => (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const no = (r, reason, re) => { assert.deepStrictEqual([r.ok, r.reason], [false, reason], JSON.stringify(r)); assert.match(r.detail, re); };
  no(await lista(await crudo(contesta('<html>no</html>'))), 'no_medido', /no es JSON/);
  no(await lista(await crudo(contesta({ message: 'no soy una lista' }))), 'no_medido', /no es una lista de proyectos/);
  no(await lista(await crudo(contesta([proyecto('acme', 'web')], { 'x-next-page': '1' }))), 'no_medido', /no sigue a la 1/);
  no(await lista(await puertoCerrado()), 'red', /no pude hablar con el servidor/);
  // el tope total vence con el pedido en vuelo
  const lenta = await crudo((req, res) => setTimeout(() => contesta([])(req, res), 3000));
  no(await lista(lenta, { TYCON_GITLAB_DEADLINE_MS: '300' }), 'no_medido', /tope de tiempo total pidiendo/);
  // lo que se rechaza antes de pedir: una fuente sin grupo y un puerto que no es un puerto
  no(await lista(lenta, {}, { platform: 'gitlab', host: 'localhost' }), 'rechazado', /namespace/);
  no(await lista('8o8'), 'rechazado', /no es un puerto/);
  // un proyecto que el servidor repite entre páginas se cuenta una vez
  const lab = await gitlab({ grupos: { acme: [[proyecto('acme', 'web')], [proyecto('acme', 'web'), proyecto('acme', 'api')]] } });
  const r = await lista(lab.port);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value.map((p) => p.id), ['acme/web', 'acme/api']);
});

test('T33 Gitlab_ClonQueFallaDiceElMotivo @story-1.6 @ac-13', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/web', { 'README.md': '# w\n' });
  const vacio = path.join(repos, 'acme', 'vacio.git');
  fs.mkdirSync(vacio, { recursive: true });
  git(vacio, ['init', '--quiet', '--bare']);
  const lab = await gitlab({ repos });
  const m = mundo();
  const env = { TYCON_GITLAB_PORT: String(lab.port) };
  const clon = async (args, e = env) =>
    resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), credential: TOKEN, ...args }, e)).out);
  const no = (r, reason, re) => {
    assert.deepStrictEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
    assert.match(r.detail, re);
    assert.ok(!r.detail.includes(TOKEN), 'el motivo no trae el token');
  };
  // un repo sin commits: se mide, sin carpeta
  let dest = path.join(tmp('c-'), 'vacio');
  let r = await clon({ id: 'acme/vacio', dest, sparse: ['package.json'] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.value, { dir: null, empty: true });
  assert.ok(!fs.existsSync(dest), 'no queda la carpeta del repo vacío');
  // un repo que el servidor no tiene, y un servidor que no contesta: no queda carpeta a medias
  dest = path.join(tmp('c-'), 'nohay');
  no(await clon({ id: 'acme/nohay', dest, depth: 1 }), 'no_encontrado', /no existe o el token no lo ve/);
  assert.ok(!fs.existsSync(dest));
  dest = path.join(tmp('c-'), 'red');
  no(await clon({ id: 'acme/web', dest, depth: 1 }, { TYCON_GITLAB_PORT: String(await puertoCerrado()) }), 'red', /no pude hablar con el servidor/);
  assert.ok(!fs.existsSync(dest));
  // lo que se rechaza antes de clonar: una carpeta que ya existe y un id que no es <grupo>/<proyecto> (con `..` lo frena
  // la capa; sin grupo, el conector)
  no(await clon({ id: 'acme/web', dest: tmp('ya-'), depth: 1 }), 'rechazado', /ya existe/);
  no(await clon({ id: '../afuera', dest: path.join(tmp('c-'), 'x'), depth: 1 }), 'rechazado', /el repo que dio la lista/);
  no(await clon({ id: 'web', dest: path.join(tmp('c-'), 'x'), depth: 1 }), 'rechazado', /no es un proyecto de GitLab/);
});

// ── lo que pidió la revisión del pedido ─────────────────────────────────────────────────────────────────────────────

/** Un repo bare con una historia que cambia de estado en tres commits (lo que leen las métricas). */
function repoConHistoria(root, full) {
  const bare = path.join(root, `${full}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '--quiet', '--bare']); git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(bare, ['config', 'uploadpack.allowFilter', 'true']); git(bare, ['config', 'http.receivepack', 'false']);
  const s = path.join(tmp('semilla-'), 'x');
  git(path.dirname(s), ['clone', '--quiet', bare, s]);
  for (const [i, st] of ['draft', 'ready-for-dev', 'done'].entries()) {
    write(s, { 'stories/s1.md': `---\nstory: S-1\nstatus: ${st}\n---\n# Uno\n`, 'src/app.js': `x${i}\n`, '.tycon/x.json': `{"v":${i}}\n` });
    git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', st], { GIT_COMMITTER_DATE: `2026-01-0${i + 1}T00:00:00Z`, GIT_AUTHOR_DATE: `2026-01-0${i + 1}T00:00:00Z` });
  }
  git(s, ['branch', '-M', 'main']); git(s, ['push', '--quiet', 'origin', 'main']);
  return bare;
}

test('T34 Fuente_LasMetricasLeenElHistorialSinCredencial @story-1.6 @ac-6', async () => {
  const repos = tmp('gl-repos-');
  repoConHistoria(repos, 'acme/web');
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'web')]] } });
  const m = mundo();
  const SM = require(path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
  // las métricas corren en otro paso y otro proceso (su git es sincrónico: en este proceso trabaría al laboratorio), sin
  // la credencial y sin terminal que pregunte usuario, como en la noche
  const transiciones = async (dir) => {
    const codigo = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'))})`
      + `.derivarTransiciones(${JSON.stringify(dir)}, [{ file: ${JSON.stringify(path.join(dir, 'stories', 's1.md'))}, id: 'S-1' }])))`;
    const r = await run(process.execPath, ['-e', codigo], { env: { ...m.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.strictEqual(r.code, 0, r.all);
    return JSON.parse(r.out);
  };
  // la noche clona la fuente: el clon liviano trae el historial de los Markdown mientras tiene la credencial
  const r = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)] });
  assert.strictEqual(r.code, 0, r.all);
  assert.strictEqual(fuente(r.estado, /gitlab/).estado, 'medida', r.all);
  const [folder] = Object.keys(r.index);
  const dir = path.join(r.dest, folder);
  assert.strictEqual(SM.esClonParcial(dir), true, 'sigue siendo un clon liviano');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'), /extraheader|oauth2|glpat/i, 'sin la credencial en el disco');
  let antes = lab.pedidos.length;
  const t = await transiciones(dir);
  assert.deepStrictEqual(t.storiesFaltantes, [], JSON.stringify(t));
  assert.strictEqual(t.medidas, 1, JSON.stringify(t));
  assert.strictEqual(lab.pedidos.length, antes, 'las métricas no le pidieron nada al servidor');
  // sin `history`, el mismo clon deja las transiciones no medidas (el pedido de las métricas sale sin credencial y el
  // servidor lo rechaza): la prueba distingue
  const d2 = path.join(tmp('clon-'), 'w');
  const c = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/web', dest: d2, sparse: ['**/*.md'], credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port) })).out);
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.strictEqual(c.value.history, undefined);
  antes = lab.pedidos.length;
  const t2 = await transiciones(d2);
  assert.deepStrictEqual(t2.storiesFaltantes, ['S-1'], JSON.stringify(t2));
  const pedidos = lab.pedidos.slice(antes).filter((p) => /\.git\//.test(p.path));
  assert.ok(pedidos.length && pedidos.every((p) => !p.headers.authorization), 'el pedido de las métricas salió sin credencial');
});

test('T35 Fuente_HistorialIncompletoEsMedidaEnParte @story-1.6 @ac-13', () => {
  const H = require(path.join(ROOT, 'scripts', 'lib', 'clone-history.js'));
  const log = ':100644 100644 0000000000000000000000000000000000000000 aaaa000000000000000000000000000000000001 A\tstories/s1.md\n'
    + ':100644 100644 aaaa000000000000000000000000000000000001 bbbb000000000000000000000000000000000002 M\tstories/s1.md\n';
  const llamadas = [];
  const git = (falla) => (a) => { llamadas.push(a); return a.includes('log') ? { status: 0, stdout: log } : { status: falla ? 128 : 0 }; };
  assert.deepStrictEqual(H.bajarHistorial(git(false), '/x', ['*.md']), { ok: true, total: 2, faltan: 0, detail: null });
  const f = H.bajarHistorial(git(true), '/x', ['*.md']);
  assert.deepStrictEqual([f.ok, f.faltan, f.total], [false, 2, 2]);
  assert.match(f.detail, /2 de 2 versiones[^\n]*no medidas/);
  assert.ok(llamadas.some((a) => a.includes('fetch') && a.includes('bbbb000000000000000000000000000000000002')));
  // un historial que no se lee no es un historial vacío
  assert.strictEqual(H.bajarHistorial(() => ({ status: 128 }), '/x', ['*.md']).ok, false);
  // el contrato: history va sólo con el clon liviano, y es una lista de pathspecs
  const base = { source: { platform: 'gitlab' }, id: 'acme/web', dest: '/tmp/x' };
  assert.strictEqual(C().sourceArgsProblem('repos.clone', { ...base, sparse: ['**/*.md'], history: ['*.md'] }), null);
  assert.match(C().sourceArgsProblem('repos.clone', { ...base, depth: 1, history: ['*.md'] }), /sólo con sparse/);
  assert.match(C().sourceArgsProblem('repos.clone', { ...base, sparse: ['**/*.md'], history: ['--upload-pack=x'] }), /pathspecs/);
});

/** Un `git` de mentira adelante en el PATH que anota los argumentos y las claves (no los valores) de GIT_CONFIG_*. */
function gitEspia() {
  const bin = tmp('espia-');
  const log = path.join(bin, 'argv.log');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "ARGV $*" >> '${log}'\ni=0; while [ "$i" -lt "\${GIT_CONFIG_COUNT:-0}" ]; do eval "printf 'KEY %s\\\\n' \\"\\$GIT_CONFIG_KEY_$i\\"" >> '${log}'; i=$((i+1)); done\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return { bin, leer: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), limpiar: () => fs.rmSync(log, { force: true }) };
}

test('T36 Secreto_NiEnLosArgumentosDeGit @story-1.6 @ac-10', async () => {
  const repos = tmp('gl-repos-');
  repoConHistoria(repos, 'acme/web');
  const lab = await gitlab({ repos });
  const m = mundo();
  const espia = gitEspia();
  const PATH = `${espia.bin}${path.delimiter}${process.env.PATH}`;
  const b64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
  const secretos = new RegExp(`${TOKEN}|${b64}|${Buffer.from(`x-access-token:${GH_TOKEN}`).toString('base64')}|${GH_TOKEN}|extraheader|authorization`, 'i');
  // GitLab: el clon liviano con su historial (los patrones del núcleo traen .tycon/: las métricas lo miden) y el completo
  for (const args of [{ sparse: ['**/*.md', '.tycon/**'], history: ['*.md'] }, { depth: 1 }]) {
    espia.limpiar();
    const dest = path.join(tmp('clon-'), 'w');
    const r = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/web', dest, credential: TOKEN, ...args }, { TYCON_GITLAB_PORT: String(lab.port), PATH })).out);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    if (args.history) assert.strictEqual(r.value.history, 'completa', JSON.stringify(r));
    const log = espia.leer();
    assert.match(log, /^ARGV clone/m, 'el espía vio el clon');
    assert.doesNotMatch(log.split('\n').filter((l) => l.startsWith('ARGV')).join('\n'), secretos, 'ningún argumento lleva la credencial');
    assert.match(log, /^KEY http\.extraheader$/m, 'la cabecera viaja por el entorno');
    assert.match(log, /^KEY http\.followRedirects$/m, 'sin seguir redirecciones');
  }
  // GitHub: el mismo trato (la credencial por el entorno, sin seguir redirecciones)
  const base = tmp('gh-');
  const gh = githubLab(base, ['web']);
  for (const args of [{ sparse: ['**/*.md'], history: ['*.md'] }, { depth: 1 }]) {
    espia.limpiar();
    const dest = path.join(tmp('clon-'), 'w');
    const r = resultado((await capa(m, 'repos.clone', { source: { platform: 'github', org: 'acme' }, id: 'acme/web', dest, credential: GH_TOKEN, ...args },
      { GITHUB_SERVER_URL: `file://${gh.server}`, PATH })).out);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const log = espia.leer();
    assert.doesNotMatch(log.split('\n').filter((l) => l.startsWith('ARGV')).join('\n'), secretos, 'ningún argumento lleva la credencial');
    assert.match(log, /^KEY http\.extraheader$/m);
    assert.match(log, /^KEY http\.followRedirects$/m);
  }
  // los dos modos de siempre de clone-repos.sh (sin fuentes): `org` y `declared`
  const ghEnv = { ...m.env, PATH, ORG_TOKEN: GH_TOKEN, ORG_TOKEN_KIND: 'user', OWNERS: 'acme', TYCON_GH_CMD: FAKE_GH, FAKE_GH_STATE: gh.state, GITHUB_SERVER_URL: `file://${gh.server}` };
  for (const [modo, input] of [['--org', undefined], ['--declared', 'Acme/web\tacme/web\n']]) {
    espia.limpiar();
    const dest = path.join(tmp('modo-'), 'repos');
    const r = await run('bash', [CLONE_SH, modo, dest, ...(modo === '--org' ? ['--team-repos', m.teamRepos] : [])], { cwd: base, env: ghEnv, input });
    assert.strictEqual(r.code, 0, r.all);
    const log = espia.leer();
    assert.match(log, /^ARGV clone/m, `${modo}: el espía vio el clon`);
    assert.doesNotMatch(log.split('\n').filter((l) => l.startsWith('ARGV')).join('\n'), secretos, `${modo}: ningún argumento lleva la credencial`);
    assert.match(log, /^KEY http\.extraheader$/m, modo);
    assert.match(log, /^KEY http\.followRedirects$/m, modo);
    const clon = modo === '--org' ? path.join(dest, 'acme__web') : path.join(dest, 'Acme', 'web');
    assert.doesNotMatch(fs.readFileSync(path.join(clon, '.git', 'config'), 'utf8'), /extraheader|authorization/i, `${modo}: sin la cabecera en el disco`);
  }
});

test('T41 Fuente_SinHuellaDelArnesNoBajaHistorial @story-1.6 @ac-6', async () => {
  const repos = tmp('gl-repos-');
  repoBare(repos, 'acme/suelto', { 'README.md': '# s\n', 'docs/a.md': 'a\n' });
  repoConHistoria(repos, 'acme/web');
  const lab = await gitlab({ repos, grupos: { acme: [[proyecto('acme', 'suelto'), proyecto('acme', 'web')]] } });
  const m = mundo();
  const espia = gitEspia();
  const PATH = `${espia.bin}${path.delimiter}${process.env.PATH}`;
  const clon = async (id) => {
    espia.limpiar();
    const dest = path.join(tmp('clon-'), 'x');
    const r = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id, dest, sparse: ['**/*.md', '.tycon/**'], history: ['*.md'], credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port), PATH })).out);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return { r, fetch: /^ARGV -C \S+ fetch /m.test(espia.leer()) };
  };
  // sin .tycon/ ni .advisors/ las métricas no lo miden: no se baja su historial
  const suelto = await clon('acme/suelto');
  assert.strictEqual(suelto.r.value.history, 'innecesaria');
  assert.strictEqual(suelto.fetch, false, 'no se pidió el historial');
  // con .tycon/, sí
  const web = await clon('acme/web');
  assert.strictEqual(web.r.value.history, 'completa');
  assert.strictEqual(web.fetch, true, 'se pidió el historial');
  // y la noche da la fuente por medida: un historial innecesario no es uno incompleto
  const n = await noche(m, { port: lab.port, creds: { gitlab: TOKEN }, sources: [GL_SRC(lab.port)] });
  assert.strictEqual(n.code, 0, n.all);
  assert.strictEqual(fuente(n.estado, /gitlab/).estado, 'medida', n.all);
  assert.strictEqual(fuente(n.estado, /gitlab/).repos, 2);
});

test('T40 Secreto_LaConfiguracionPreviaDeGitSigue @story-1.6 @ac-10', () => {
  const { conConfigDeGit } = require(path.join(ROOT, 'scripts', 'lib', 'clean-git-env.js'));
  // un runner que ya le pasa a git un proxy por el entorno: el par previo sigue llegando, y el nuevo se suma después
  const previo = { ...sinGitDelPadre(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://proxy.empresa:3128' };
  const env = conConfigDeGit(previo, { 'http.followRedirects': 'false', 'http.extraheader': 'X-Prueba: 1' });
  assert.strictEqual(env.GIT_CONFIG_COUNT, '3');
  const leer = (k) => spawnSync('git', ['config', '--get', k], { env, encoding: 'utf8', cwd: tmp('cfg-') }).stdout.trim();
  assert.strictEqual(leer('http.proxy'), 'http://proxy.empresa:3128');
  assert.strictEqual(leer('http.extraheader'), 'X-Prueba: 1');
  assert.strictEqual(leer('http.followRedirects'), 'false');
  // sin configuración previa, empieza en 0
  const solo = conConfigDeGit({ PATH: process.env.PATH }, { a: '1' });
  assert.deepStrictEqual([solo.GIT_CONFIG_COUNT, solo.GIT_CONFIG_KEY_0, solo.GIT_CONFIG_VALUE_0], ['1', 'a', '1']);
});

test('T37 Gitlab_ClonCompletoEsLaRamaMain @story-1.6 @ac-6', async () => {
  const repos = tmp('gl-repos-');
  const bare = repoBare(repos, 'acme/api', { 'api.sln': '\n' });
  // la rama por defecto del servidor es otra: la revisión de dependencias mira main igual
  const s = path.join(tmp('semilla-'), 'x');
  git(path.dirname(s), ['clone', '--quiet', bare, s]);
  git(s, ['checkout', '--quiet', '-b', 'dev']); write(s, { 'dev.txt': 'd\n' }); git(s, ['add', '-A']); git(s, ['commit', '--quiet', '-m', 'dev']);
  git(s, ['push', '--quiet', 'origin', 'dev']);
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/dev']);
  const lab = await gitlab({ repos });
  const m = mundo();
  const dest = path.join(tmp('clon-'), 'api');
  const r = resultado((await capa(m, 'repos.clone', { source: GL_SRC(lab.port), id: 'acme/api', dest, depth: 1, credential: TOKEN }, { TYCON_GITLAB_PORT: String(lab.port) })).out);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(git(dest, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  assert.ok(!fs.existsSync(path.join(dest, 'dev.txt')));
});

test('T38 Tablero_SeccionRotaNoMuestraLaDeAyer @story-1.6 @ac-9', async () => {
  const m = mundo();
  const D = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js'));
  for (const [caso, escribir, re] of [
    ['sección con problemas', (f) => operations(path.dirname(f), [{ platform: 'gitlab', namespace: 'acme' }, { platform: 'bitbucket', org: 'x' }]), /^gitlab:[^\n]*acme$/],
    ['archivo que no valida', (f) => fs.writeFileSync(f, JSON.stringify({ version: 'uno', nightly: { sources: [{ platform: 'gitlab', namespace: 'acme' }] } })), /^gitlab:[^\n]*acme$/],
    ['archivo ilegible', (f) => fs.writeFileSync(f, '{ no es json'), /las fuentes de la noche/],
  ]) {
    const base = tmp('rota-');
    const f = path.join(base, 'operations.json');
    escribir(f);
    const dash = path.join(base, '.dashboard');
    // el estado de ayer: medida
    fs.mkdirSync(dash, { recursive: true });
    fs.writeFileSync(path.join(dash, 'nightly-sources-2026-11-26.json'), JSON.stringify({ fecha: '2026-11-26', generado: '2026-11-26T03:00:00Z', fuentes: [{ fuente: 'gitlab:acme', estado: 'medida', repos: 3 }] }));
    // la noche de hoy, por clone-repos.sh: vuelve al camino de siempre (acá, sin credencial) y deja el estado del día
    const hoy = '2026-11-27';
    const r = await run('bash', [CLONE_SH, '--org', path.join(base, 'repos')], { cwd: base, env: { ...m.env, OPERATIONS_FILE: f, DASHBOARD_DIR: dash, TYCON_TODAY: hoy } });
    assert.match(r.out, /::warning::[^\n]*lo de hoy/, `${caso}: ${r.all}`);
    const archivo = path.join(dash, `nightly-sources-${hoy}.json`);
    assert.ok(fs.existsSync(archivo), `${caso}: sin el estado del día\n${r.all}`);
    const doc = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    assert.ok(doc.fuentes.length >= 1 && doc.fuentes.every((x) => x.estado === 'no_medida'), `${caso}: ${JSON.stringify(doc)}`);
    assert.ok(doc.fuentes.some((x) => re.test(x.fuente)), `${caso}: ${JSON.stringify(doc.fuentes)}`);
    assert.ok(doc.fuentes.every((x) => /esta noche no se midió/.test(x.detalle)));
    // el tablero lee el de hoy: «no medida», nunca el «medida» de ayer
    const ficha = D.fichaFuentes(doc, hoy);
    assert.ok(ficha.fuentes.every((x) => x.estado === 'no_medida'), `${caso}: ${JSON.stringify(ficha)}`);
  }
  // sin sección nightly, nada cambia: no se escribe estado
  const base = tmp('sin-');
  const dash = path.join(base, '.dashboard');
  const d = await run(process.execPath, [SOURCES, 'declared', '--operations', operations(base), '--dashboard', dash], { env: m.env });
  assert.strictEqual(d.code, 1, d.all);
  assert.ok(!fs.existsSync(dash), 'sin fuentes declaradas no hay estado que escribir');
});

test('T39 Dependencias_RepoDeFuenteNoSeDiceFueraDeLaLista @story-1.6 @ac-8', () => {
  const WI = require(path.join(ROOT, 'scripts', 'nightly', 'dependencies', 'work-items.js'));
  const cfg = { repos: [
    { producto: 'Acme', ruta: 'Acme/back', tipo: 'npm', source: { platform: 'gitlab', host: 'localhost', namespace: 'acme', repo: 'back' } },
    { producto: 'Acme', ruta: 'Acme/web', tipo: 'npm', github: 'acme/web' },
  ] };
  const ficha = { viva: true, contando: false, txt: '', fi: { listas: { repos: ['Acme/back', 'Acme/web', 'Otro/suelto'] }, escalares: {} } };
  const [p] = WI.paresPorPedir([ficha], cfg);
  assert.deepStrictEqual(p.faltan, ['acme/web'], 'el issue se pide sólo donde hay un repo de GitHub');
  assert.deepStrictEqual(p.desconocidos, ['Acme/back', 'Otro/suelto']);
  assert.deepStrictEqual(p.deFuente, ['Acme/back'], 'el de la fuente está en la lista: no se dice «fuera de repos.json»');
  for (const c of ['github', 'azure-devops']) {
    const t = fs.readFileSync(path.join(ROOT, 'integrations', c, 'scripts', 'dependency-notices.js'), 'utf8');
    assert.match(t, /repo\(s\) de una fuente: \$\{deFuente\.join/, `${c}: el aviso nombra los repos de fuente aparte`);
  }
});

// ── el diff de la historia (AC11) ────────────────────────────────────────────────────────────────────────────────────

/**
 * La base del diff: TYCON_DIFF_BASE, o la primera que dé un merge-base entre la rama que sigue la actual, origin/main
 * (en la CI el checkout es el commit de la mezcla: no hay rama de arriba ni main local) y main. null si no hay ninguna.
 */
function baseDelDiff() {
  const cand = [];
  if (process.env.TYCON_DIFF_BASE) cand.push(process.env.TYCON_DIFF_BASE);
  const u = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: ROOT, encoding: 'utf8' });
  if (u.status === 0 && u.stdout.trim()) cand.push(u.stdout.trim());
  cand.push('origin/main', 'main');
  for (const ref of cand) {
    const b = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: ROOT, encoding: 'utf8' });
    if (b.status === 0 && b.stdout.trim()) return b.stdout.trim();
  }
  return null;
}

/** El diff de la historia contra su base (lo commiteado y lo que no), con los archivos nuevos sin seguimiento; null sin base. */
function diffReal() {
  const base = baseDelDiff();
  if (!base) return null;
  let d = spawnSync('git', ['diff', '-U0', base], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;
  const nuevos = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of nuevos) {
    let t = ''; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { continue; }
    d += `diff --git a/${f} b/${f}\n+++ b/${f}\n${t.split('\n').map((l) => `+${l}`).join('\n')}\n`;
  }
  return d;
}

const EXCLUIDOS = ['pipelines/operations/github/README.md', 'pipelines/operations/examples/operations.json'];

/** Las líneas agregadas a un archivo del núcleo que nombran una plataforma. */
function nombresNuevos(diff, names, core) {
  const re = new RegExp(`\\b(${names.join('|')})\\b`, 'i');
  const out = [];
  let archivo = null;
  for (const l of diff.split('\n')) {
    const m = l.match(/^\+\+\+ b\/(.+)$/);
    if (m) { archivo = m[1]; continue; }
    if (!archivo || !l.startsWith('+') || l.startsWith('+++')) continue;
    // fuera del núcleo: la regla de check-core-neutrality.js, más lo que el AC16 pide nombrar (el README de la noche de
    // GitHub y el ejemplo) y los registros de la corrida, que no son código
    if (!core(archivo) || EXCLUIDOS.includes(archivo) || /^(stories|\.advisors)\//.test(archivo)) continue;
    if (re.test(l)) out.push({ archivo, linea: l.slice(1).trim() });
  }
  return out;
}
