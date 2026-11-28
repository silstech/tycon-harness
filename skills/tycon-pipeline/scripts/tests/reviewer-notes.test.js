'use strict';

/**
 * reviewer-notes.test.js — las notas que un paquete le deja a un revisor del núcleo (lib/reviewer-notes.js).
 *
 * EL AGUJERO QUE CIERRA: un revisor del núcleo sirve para cualquier organización y cualquier lenguaje, y lo de un stack
 * (el logger de un framework sin BeginScope, la forma de las rutas de un host) estaba escrito en su texto. Mudarlo al
 * paquete sin una forma de llegar al revisor tiene un modo de falla que no da error: en un repo de ese stack el revisor
 * deja de saberlo y vuelven los hallazgos falsos. Estas pruebas sostienen que (1) la nota de un paquete activo llega al
 * contexto de la vuelta, nombrando revisor y paquete; (2) la de un paquete que el repo no activa no llega; (3) una nota
 * mal puesta (para un revisor que no es del núcleo, vacía, demasiado grande, o un archivo que no es una nota) es un
 * paquete roto, nunca una nota que se descarta en silencio.
 *
 * Lanza un proceso con HOME y sesión aislados para el contexto de la vuelta: buildAdvisorContext escribe en la carpeta
 * de estado de la HOME.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const notas = require('../lib/reviewer-notes.js');
const packsLib = require('../lib/packs.js');

const TC = 'tycon-plugin-tests-coverage';
const SB = 'tycon-plugin-security-basics';
const NUCLEO = [TC, SB];

function tmp(prefijo) { return fs.mkdtempSync(path.join(os.tmpdir(), prefijo)); }

/** Un paquete de laboratorio con un revisor propio y las notas que se pidan ({ <archivo>: <texto> }). */
function paqueteDeLaboratorio({ nombre = 'lab', notasDelPaquete = {} } = {}) {
  const packs = tmp('notas-packs-');
  const agentes = tmp('notas-agentes-');
  const dir = path.join(packs, nombre);
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'lab-reviewer.md'), '---\nname: lab-reviewer\n---\n# lab\n');
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({
    name: nombre, description: 'paquete de laboratorio',
    reviewers: [{ agent: 'lab-reviewer', group: 'base', when: { detection: 'codeModified' }, surface: { always: true }, depth: 'standard', prefixes: ['LAB'] }],
  }, null, 2));
  for (const [archivo, texto] of Object.entries(notasDelPaquete)) {
    const ruta = path.join(dir, 'reviewer-notes', archivo);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, texto);
  }
  for (const a of NUCLEO) fs.writeFileSync(path.join(agentes, `${a}.md`), `---\nname: ${a}\n---\n`);
  return { packs, agentes, dir };
}

function cargar(lab) {
  packsLib.resetCache();
  return packsLib.cargarPaquetes({ packsDir: lab.packs, agentsDir: lab.agentes, nucleo: NUCLEO, banderas: packsLib.BANDERAS });
}

test('T1 Notas_PaqueteActivo_EntranAlBloque @A237 — la nota llega con el revisor y el paquete que la trae', () => {
  const lab = paqueteDeLaboratorio({ notasDelPaquete: { [`${TC}.md`]: 'El logger del host no tiene BeginScope: un prefijo en el mensaje cumple.\n' } });
  const instalados = cargar(lab);
  assert.deepStrictEqual(instalados[0].notas.map((n) => n.revisor), [TC], 'el paquete cargado lista su nota');
  const bloque = notas.bloqueDeNotas(instalados);
  assert.match(bloque, /^## Notas de los paquetes para los revisores del núcleo/m);
  assert.match(bloque, new RegExp(`### Para \`${TC}\` — paquete \`lab\``));
  assert.match(bloque, /El logger del host no tiene BeginScope/);
  assert.match(bloque, /Si no sos ese revisor, ignorala/, 'le dice a los demás revisores que no es para ellos');
});

test('T2 Notas_SinNotas_BloqueVacio @A237 — un paquete sin notas no cambia el contexto', () => {
  const lab = paqueteDeLaboratorio();
  const instalados = cargar(lab);
  assert.deepStrictEqual(instalados[0].notas, []);
  assert.strictEqual(notas.bloqueDeNotas(instalados), '');
  assert.strictEqual(notas.bloqueDeNotas([]), '');
});

test('T3 Notas_RevisorQueNoEsDelNucleo_PaqueteRoto @A237 — una nota para un revisor ajeno o propio frena nombrando el archivo', () => {
  for (const [archivo, motivo] of [['revisor-inventado.md', /no es un revisor del núcleo/], ['lab-reviewer.md', /es un revisor de este mismo paquete/]]) {
    const lab = paqueteDeLaboratorio({ notasDelPaquete: { [archivo]: 'algo\n' } });
    assert.throws(() => cargar(lab), (e) => {
      assert.ok(e instanceof packsLib.PackError, 'es un PackError');
      const err = e.errores.find((x) => String(x.archivo).endsWith(path.join('reviewer-notes', archivo)));
      assert.ok(err, `nombra el archivo de la nota: ${JSON.stringify(e.errores)}`);
      assert.match(err.motivo, motivo);
      return true;
    });
  }
});

test('T4 Notas_VaciaGrandeONoNota_PaqueteRoto @A237 — vacía, más grande que el tope o un archivo que no es .md', () => {
  const casos = [
    [{ [`${TC}.md`]: '  \n\n' }, /está vacía/],
    [{ [`${TC}.md`]: 'x'.repeat(notas.TOPE_BYTES + 1) }, /más grande que el tope/],
    [{ 'notas.txt': 'x\n' }, /no es una nota/],
  ];
  for (const [notasDelPaquete, motivo] of casos) {
    const lab = paqueteDeLaboratorio({ notasDelPaquete });
    assert.throws(() => cargar(lab), (e) => {
      assert.ok(e instanceof packsLib.PackError);
      assert.ok(e.errores.some((x) => motivo.test(x.motivo)), `${motivo}: ${JSON.stringify(e.errores)}`);
      return true;
    });
  }
  // validateTree (el instalador) dice lo mismo, sin tirar
  const lab = paqueteDeLaboratorio({ notasDelPaquete: { 'revisor-inventado.md': 'x\n' } });
  const errores = packsLib.validateTree({ packsDir: lab.packs, agentsDir: lab.agentes, nucleo: NUCLEO });
  assert.ok(errores.some((x) => /no es un revisor del núcleo/.test(x.motivo)), JSON.stringify(errores));
});

/** Corre buildAdvisorContext en un proceso con HOME, sesión y paquetes de laboratorio; devuelve el texto escrito. */
function contextoDeLaVuelta(lab, { packsDelRepo } = {}) {
  const home = tmp('notas-home-');
  const repo = tmp('notas-repo-');
  spawnSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.js'), 'module.exports = 1;\n');
  if (packsDelRepo !== undefined) {
    fs.mkdirSync(path.join(repo, '.tycon'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), `packs: [${packsDelRepo.join(', ')}]\n`);
  }
  const codigo = `
    const ctx = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'pipeline-advisor-context.js'))});
    const r = ctx.buildAdvisorContext({ repo: ${JSON.stringify(repo)}, story: null, files: ['a.js'], iter: 1 });
    const fs = require('fs');
    process.stdout.write(JSON.stringify({ shared: r && fs.readFileSync(r.context_file, 'utf8'),
      validator: r && fs.readFileSync(r.overrides['tycon-story-validator'], 'utf8') }));
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SESSION_ID: 'notas-lab', TYCON_PACKS_DIR: lab.packs,
    TYCON_AGENTS_DIR: lab.agentes, TYCON_PACKS_DEFAULT: 'all' };
  const r = spawnSync(process.execPath, ['-e', codigo], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('T5 Notas_EnElContextoDeLaVuelta_SoloConElPaqueteActivo @A237 — entran al contexto compartido y al del validador; con packs: [] no', () => {
  const lab = paqueteDeLaboratorio({ notasDelPaquete: { [`${TC}.md`]: 'NOTA-DE-LABORATORIO\n' } });
  const activo = contextoDeLaVuelta(lab);
  assert.match(activo.shared, /NOTA-DE-LABORATORIO/, 'el contexto compartido trae la nota');
  assert.match(activo.validator, /NOTA-DE-LABORATORIO/, 'el contexto recortado del validador también');
  const inactivo = contextoDeLaVuelta(lab, { packsDelRepo: [] });
  assert.doesNotMatch(inactivo.shared, /NOTA-DE-LABORATORIO/, 'un repo que no activa el paquete no la recibe');
  assert.doesNotMatch(inactivo.shared, /Notas de los paquetes/);
});

test('T6 Notas_RevisorQueNoLasRecibe_PaqueteRoto @A237 — retrospectiva y alcance firmado no reciben notas; el adversarial de la historia sí', () => {
  assert.deepStrictEqual(Object.keys(notas.NO_RECIBEN).sort(), ['tycon-retrospective-capturer', 'tycon-signed-scope-audit']);
  const adversarial = paqueteDeLaboratorio({ notasDelPaquete: { 'tycon-story-adversarial-reviewer.md': 'algo\n' } });
  assert.deepStrictEqual(notas.validarNotas(adversarial.dir, { nucleo: NUCLEO }), [], 'el adversarial no está en el set de la vuelta y recibe notas igual');
  for (const revisor of Object.keys(notas.NO_RECIBEN)) {
    const lab = paqueteDeLaboratorio({ notasDelPaquete: { [`${revisor}.md`]: 'algo\n' } });
    const errores = notas.validarNotas(lab.dir, { nucleo: [...NUCLEO, revisor] });
    assert.ok(errores.some((x) => x.revisor === revisor && /no recibe notas/.test(x.motivo)), `${revisor}: ${JSON.stringify(errores)}`);
  }
});

test('T7 Notas_BasuraDelSistemaYEnlaces @A237 — .DS_Store y Thumbs.db se ignoran; un enlace es un paquete roto', () => {
  const lab = paqueteDeLaboratorio({ notasDelPaquete: { [`${TC}.md`]: 'nota\n', '.DS_Store': 'x', 'Thumbs.db': 'x' } });
  assert.deepStrictEqual(notas.validarNotas(lab.dir, { nucleo: NUCLEO }), [], 'lo que deja el sistema operativo no rompe el paquete');
  assert.deepStrictEqual(notas.listarNotas(lab.dir).map((n) => n.revisor), [TC]);
  const afuera = path.join(tmp('notas-afuera-'), 'secreto.md');
  fs.writeFileSync(afuera, 'lo de afuera\n');
  try { fs.symlinkSync(afuera, path.join(lab.dir, 'reviewer-notes', `${SB}.md`)); } catch (_e) { return; }   // sin permiso para enlaces (Windows): no aplica
  const errores = notas.validarNotas(lab.dir, { nucleo: NUCLEO });
  assert.ok(errores.some((x) => x.revisor === SB && /es un enlace/.test(x.motivo)), JSON.stringify(errores));
});

test('T8 Notas_FueraDeLaVuelta_ValidatorsYComando @A237 — el validador las recibe en notas_paquete y el de «Probar en vivo» por reviewer-notes', () => {
  const lab = paqueteDeLaboratorio({ notasDelPaquete: { 'tycon-story-validator.md': 'NOTA-DEL-VALIDADOR\n', 'tycon-dod-runtime-checker.md': 'NOTA-DE-DOD\n', 'tycon-story-adversarial-reviewer.md': 'NOTA-DEL-ADVERSARIAL\n' } });
  for (const a of ['tycon-story-validator', 'tycon-dod-runtime-checker', 'tycon-story-adversarial-reviewer']) fs.writeFileSync(path.join(lab.agentes, `${a}.md`), `---\nname: ${a}\n---\n`);
  const home = tmp('notas-home-');
  const repo = tmp('notas-repo-');
  spawnSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  const story = path.join(repo, 'story.md');
  fs.writeFileSync(story, '---\nstory: "9.9"\nstatus: ready-for-dev\n---\n# Historia de laboratorio\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SESSION_ID: 'notas-lab', TYCON_PACKS_DIR: lab.packs, TYCON_AGENTS_DIR: lab.agentes, TYCON_PACKS_DEFAULT: 'all' };
  delete env.TYCON_STORY_REVIEW;   // apagado en la máquina que corre la suite, el portón saltearía al adversarial
  const pipeline = path.join(SCRIPTS, 'pipeline.js');
  const v = spawnSync(process.execPath, [pipeline, 'validators', '--story', story, '--repo', repo], { env, encoding: 'utf8' });
  assert.strictEqual(v.status, 0, v.stderr);
  const salida = JSON.parse(v.stdout);
  assert.match(salida.notas_paquete['tycon-story-validator'] || '', /NOTA-DEL-VALIDADOR/);
  assert.doesNotMatch(JSON.stringify(salida.notas_paquete), /NOTA-DE-DOD/, 'sólo las de los validadores que se lanzan');
  const adv = (salida.lanzamientos || []).find((l) => l.agente === 'tycon-story-adversarial-reviewer');
  assert.ok(adv, `una historia nueva lanza al adversarial: ${JSON.stringify(salida.lanzamientos)}`);
  assert.match(adv.prompt, /NOTA-DEL-ADVERSARIAL/, 'el adversarial la recibe dentro de su pedido');
  assert.doesNotMatch(JSON.stringify(salida.notas_paquete), /NOTA-DEL-ADVERSARIAL/, 'la del adversarial no se repite en notas_paquete');
  const c = spawnSync(process.execPath, [pipeline, 'reviewer-notes', '--agent', 'tycon-dod-runtime-checker', '--repo', repo], { env, encoding: 'utf8' });
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(c.stdout, /NOTA-DE-DOD/);
  assert.doesNotMatch(c.stdout, /NOTA-DEL-VALIDADOR/);
  const mal = spawnSync(process.execPath, [pipeline, 'reviewer-notes', '--agent', 'tycon-dod-runtime-cheker', '--repo', repo], { env, encoding: 'utf8' });
  assert.strictEqual(mal.status, 2, 'un nombre mal escrito frena: no sale vacío como «sin notas»');
  assert.match(mal.stderr, /no es un revisor del núcleo que reciba notas/);
  const vacio = spawnSync(process.execPath, [pipeline, 'reviewer-notes', '--agent', TC, '--repo', repo], { env, encoding: 'utf8' });
  assert.strictEqual(vacio.status, 0, vacio.stderr);
  assert.strictEqual(vacio.stdout, '', 'sin notas para ese revisor no imprime nada');
});
