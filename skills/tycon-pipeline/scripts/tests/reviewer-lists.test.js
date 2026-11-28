'use strict';

/**
 * reviewer-lists.test.js — lo que un revisor dice que busca es lo mismo que lo que lo dispara.
 *
 * Lo que sostiene: un revisor que el pipeline lanza por un archivo de Python, Go, Java o Ruby sabe qué buscar en ese
 * archivo. Si el disparo reconoce un lenguaje o una marca que el texto del revisor no nombra, el revisor devuelve
 * «limpio» sin haber mirado (el «falso limpio»). Las listas viven en code-files.js; el texto de cada revisor las nombra
 * y esta prueba compara las dos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TYCON_PACKS_DEFAULT = (process.env.TYCON_PACKS_DEFAULT || '').trim() || 'all';

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const cf = () => require(path.join(SCRIPTS, 'lib', 'code-files.js'));
const revisor = (nombre) => fs.readFileSync(path.join(RAIZ, 'agents', `${nombre}.md`), 'utf8');
const setDe = (repo, files) => require(path.join(SCRIPTS, 'pipeline.js')).computeAdvisorSet({ repo, story: null, files }).all;
const repoCon = (archivos) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'revisor-listas-'));
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), txt);
  }
  return repo;
};

// 🔴 Falla con: deferral-tracker se lanza por una prueba salteada de pytest o de Go, pero su texto sólo nombraba las de
//    JS y xUnit; y una prueba de Java, Kotlin, Ruby o Swift salteada no se reconocía como prueba ni como salteada.
test('DeferralTracker_LasMarcasDelTextoSonLasDelDisparo', () => {
  const { SKIP_MARKS, hasSkipMark, isTestFile } = cf();
  assert.ok(Array.isArray(SKIP_MARKS) && SKIP_MARKS.length, 'las marcas de prueba salteada, por lenguaje, en una lista');
  const texto = revisor('tycon-deferral-tracker');
  for (const g of SKIP_MARKS) {
    assert.ok(texto.includes(g.language), `el texto nombra ${g.language}`);
    for (const m of g.marks) {
      assert.ok(texto.includes(`\`${m}\``), `el texto nombra la marca ${m} (${g.language})`);
      assert.ok(hasSkipMark(m, g.example), `la marca ${m} se reconoce en ${g.example}`);
    }
    assert.ok(isTestFile(g.example), `${g.example} es una prueba`);
  }
  for (const lenguaje of ['Python', 'Go', 'Java', 'Kotlin', 'Ruby', 'Swift']) {
    assert.ok(SKIP_MARKS.some((g) => g.language.includes(lenguaje)), `hay marcas de ${lenguaje}`);
  }
  // las marcas de un lenguaje sólo valen en sus archivos: `@Disabled` en un .ts no es una prueba salteada
  assert.strictEqual(hasSkipMark('@Disabled', 'a.test.ts'), false);
  assert.strictEqual(hasSkipMark('  skip "falta"', 'a.test.ts'), false);
  assert.strictEqual(hasSkipMark('@Disabled', 'src/test/java/FooTest.java'), true);
  // en Ruby, `skip` y `pending` como clave o variable no son una marca; como opción de un `it`, sí
  for (const no of ['    pending: true,', '  skip: 10,', 'pending = create(:order)']) assert.strictEqual(hasSkipMark(no, 'spec/a_spec.rb'), false, no);
  for (const si of ['  it "x", skip: "motivo" do', '  it "x", :skip do', '  xspecify "y" do', '    skip("falta")']) assert.strictEqual(hasSkipMark(si, 'spec/a_spec.rb'), true, si);
  assert.ok(isTestFile('test/test_pedido.rb'), 'Minitest: test_*.rb');
});

test('DeferralTracker_SeLanzaConUnaPruebaSalteadaDeJava', () => {
  const f = 'src/test/java/PedidoTest.java';
  const repo = repoCon({ [f]: 'class PedidoTest {\n  @Disabled("falta el stock")\n  @Test void reserva() {}\n}\n' });
  assert.ok(setDe(repo, [f]).includes('tycon-deferral-tracker'), 'una prueba de Java salteada lanza al revisor');
});

// 🔴 Falla con: i18n se lanza con Python, Go, Ruby, Java, Vue o Svelte, pero su texto sólo sabía de JSX y de .NET.
test('I18n_CadaLenguajeDelDisparoTieneSuFormaEnElTexto', () => {
  const { byLanguage } = cf();
  const texto = revisor('i18n-hardcoded-text-reviewer');
  const tabla = texto.slice(texto.indexOf('<!-- lenguajes:inicio -->'), texto.indexOf('<!-- lenguajes:fin -->'));
  assert.ok(tabla.length > 30, 'el texto trae la tabla de lenguajes entre sus marcas');
  // los que no llevan texto visible propio: el proyecto .NET y los guiones
  for (const { language } of byLanguage().filter((g) => !['.NET (proyecto)', 'Shell'].includes(g.language))) {
    assert.ok(tabla.includes(`| ${language} |`), `la tabla tiene una fila para ${language}`);
  }
  assert.doesNotMatch(texto, /Ceibo/i, 'sin ejemplos de un cliente');
});

// 🔴 Falla con: e2e-realness sólo se lanzaba con `tests/e2e/*.spec.ts`: no veía `e2e/` en la raíz, `playwright/`,
//    `.spec.js`, ni la carpeta que el repo declara.
test('E2eRealness_SeLanzaConLaCarpetaYLasTerminacionesDeLaLista', () => {
  const { E2E_SPEC_EXTS, E2E_DIRS } = cf();
  assert.ok(Array.isArray(E2E_SPEC_EXTS) && E2E_SPEC_EXTS.includes('.spec.js'), 'las terminaciones de una prueba de punta a punta');
  assert.ok(Array.isArray(E2E_DIRS) && E2E_DIRS.includes('playwright'), 'las carpetas que el revisor reconoce sin que se declaren');
  const texto = revisor('tycon-e2e-realness-checker');
  for (const e of E2E_SPEC_EXTS) assert.ok(texto.includes(`\`${e}\``), `el texto nombra ${e}`);
  for (const d of E2E_DIRS) assert.ok(texto.includes(`\`${d}/\``), `el texto nombra la carpeta ${d}/`);
  assert.match(texto, /specs_dir/, 'el texto dice que lee la carpeta declarada');
  assert.doesNotMatch(texto, /ceibo/i, 'sin ejemplos de un cliente');
  const vacio = repoCon({});
  for (const f of ['e2e/login.spec.js', 'playwright/pedido.spec.ts', 'apps/web/tests/e2e/alta.spec.mjs']) {
    assert.ok(setDe(vacio, [f]).includes('tycon-e2e-realness-checker'), `${f} lanza al revisor`);
  }
  assert.ok(!setDe(vacio, ['src/util.spec.ts']).includes('tycon-e2e-realness-checker'), 'una prueba unitaria no es de punta a punta');
  assert.ok(!setDe(vacio, ['cypress/e2e/login.spec.ts']).includes('tycon-e2e-realness-checker'), 'una de Cypress no es de este revisor');
  const declarado = repoCon({ '.tycon/advisors.yaml': 'e2e:\n  specs_dir: qa/flujos\n' });
  assert.ok(setDe(declarado, ['qa/flujos/compra.spec.ts']).includes('tycon-e2e-realness-checker'), 'la carpeta declarada lanza al revisor');
  const { isE2eSpec } = cf();
  assert.ok(isE2eSpec('../Front/qa/flujos/a.spec.ts', { specsDir: 'qa/flujos/' }), 'con el repo adelante y la barra final');
  assert.ok(isE2eSpec('src/a.spec.ts', { specsDir: '.' }), '«.» es todo el repo');
  assert.ok(require(path.join(SCRIPTS, 'lib', 'path-forms.js')).isE2eSpecPath('C:\\r\\playwright\\a.spec.js'), 'el aviso del portón usa la misma lista');
});

// ── La guardiana: todo revisor del núcleo cubre los lenguajes que el núcleo sabe probar ─────────────────────────────
// Cada revisor de agents/ declara en su texto `<!-- lenguajes: <ids> | no-aplica: <ids> (motivo) -->`, o
// `<!-- lenguajes: no mira código (motivo) -->`. Por cada lenguaje que el núcleo prueba, el revisor lo cubre o dice por
// qué no aplica. Que lo cubre se mide con su disparo de verdad: el cálculo de revisores, con un archivo de ese
// lenguaje que el revisor tiene que ver (DISPAROS), y la lista de la vuelta siguiente (que lo relance si ese archivo
// cambia). Lo que falta hoy está en fixtures/reviewer-language-gaps.json y avisa; un faltante que no está ahí frena, y
// también frena un renglón del registro que ya no falta (sale del registro en el mismo commit que lo arregla: así una
// regresión posterior no queda tapada). Con el registro vacío, frena ante cualquier faltante.
const REGISTRO = path.join(__dirname, 'fixtures', 'reviewer-language-gaps.json');

/**
 * Cómo se mide el disparo de cada revisor que mira código: para un lenguaje, un repo de juguete con un archivo de ese
 * lenguaje que lo tiene que lanzar, o null si no hay forma de armarlo. Un revisor que declara lenguajes sin su
 * medición acá tiene el faltante «disparo sin medir».
 */
const DISPAROS = {
  // una prueba salteada con la marca de su lenguaje
  'tycon-deferral-tracker': (l) => {
    const { SKIP_MARKS, mayHaveSkips, hasSkipMark, extOf } = cf();
    for (const s of l.samples) {
      if (!mayHaveSkips(s)) continue;
      for (const g of SKIP_MARKS) {
        if (g.exts && !g.exts.includes(extOf(s))) continue;
        const txt = `${g.marks[0]}\n`;
        if (hasSkipMark(txt, s)) return { [s]: txt };
      }
    }
    return null;
  },
  // un archivo de código que no es prueba, en un proyecto que declara i18n
  'i18n-hardcoded-text-reviewer': (l) => {
    const s = l.samples.find((x) => !cf().isTestFile(x));
    return s ? { '.tycon/advisors.yaml': 'i18n:\n  required: true\n', [s]: 'x\n' } : null;
  },
  // una prueba de punta a punta
  'tycon-e2e-realness-checker': (l) => {
    const s = l.samples.find((x) => cf().isE2eSpec(x));
    return s ? { [s]: 'test("x", async () => {})\n' } : null;
  },
};

/** Los faltantes de cada revisor del núcleo: `{ revisor: ['rust', 'go (disparo)', 'sin declarar', …] }`. */
function faltantes() {
  const { TESTED_LANGUAGES } = cf();
  const set = require(path.join(SCRIPTS, 'lib', 'pipeline-advisor-set.js'));
  const ids = TESTED_LANGUAGES.map((l) => l.id);
  const out = {};
  for (const f of fs.readdirSync(path.join(RAIZ, 'agents')).filter((x) => x.endsWith('.md')).sort()) {
    const nombre = f.replace(/\.md$/, '');
    const m = fs.readFileSync(path.join(RAIZ, 'agents', f), 'utf8').match(/<!--\s*lenguajes:([\s\S]*?)-->/);
    const falta = [];
    if (!m) { out[nombre] = ['sin declarar']; continue; }
    const decl = m[1].trim();
    const surface = set.superficieDe(nombre);
    if (/^no mira código/.test(decl)) {
      if (!/^no mira código\s*\(.+\)$/.test(decl)) falta.push('no mira código sin motivo');
      // uno que dice no mirar código no puede lanzarse por un archivo de código
      const deCodigo = surface && !surface.always && TESTED_LANGUAGES.some((l) => l.samples.some((s) => set.advisorAffectedByDelta(nombre, [s]).affected));
      if (deCodigo) falta.push('dice que no mira código y su disparo es de código');
      if (falta.length) out[nombre] = falta;
      continue;
    }
    const [cubre, noAplica = ''] = decl.split('|');
    const cubiertos = cubre.trim().split(/[\s,]+/).filter(Boolean);
    const na = noAplica.replace(/^\s*no-aplica:\s*/, '');
    const motivo = (na.match(/\((.+)\)\s*$/) || [])[1];
    const sinAplicar = na.replace(/\(.*\)\s*$/, '').split(/[\s,]+/).filter(Boolean);
    if (sinAplicar.length && !motivo) falta.push('no-aplica sin motivo');
    for (const x of [...cubiertos, ...sinAplicar]) if (!ids.includes(x)) falta.push(`${x} (no es un lenguaje de la lista)`);
    for (const l of TESTED_LANGUAGES) {
      if (sinAplicar.includes(l.id)) continue;
      if (!cubiertos.includes(l.id)) { falta.push(l.id); continue; }
      const armar = DISPAROS[nombre];
      if (!armar) { falta.push(`${l.id} (disparo sin medir)`); continue; }
      const archivos = armar(l);
      if (!archivos || !setDe(repoCon(archivos), Object.keys(archivos).filter((x) => !x.startsWith('.tycon/'))).includes(nombre)) {
        falta.push(`${l.id} (disparo)`);
        continue;
      }
      // y la vuelta siguiente lo relanza si ese archivo cambia
      const relanza = surface && (surface.always || Object.keys(archivos).some((x) => !x.startsWith('.tycon/') && set.advisorAffectedByDelta(nombre, [x]).affected));
      if (!relanza) falta.push(`${l.id} (otra vuelta)`);
    }
    if (falta.length) out[nombre] = falta;
  }
  return out;
}

test('Guardiana_LaListaDeLenguajesSaleDeLoQueElNucleoSabeProbar', () => {
  const { TESTED_LANGUAGES } = cf();
  const runners = require(path.join(SCRIPTS, 'lib', 'test-runners.js'));
  // cada herramienta de fábrica dice qué lenguaje prueba; bash lo prueban las suites del arnés
  for (const f of runners.FACTORY) assert.ok(TESTED_LANGUAGES.some((l) => l.id === f.language), `${f.name}: su lenguaje (${f.language}) está en la lista`);
  const deHerramientas = new Set([...runners.FACTORY.map((f) => f.language), 'bash']);
  assert.deepStrictEqual([...deHerramientas].sort(), TESTED_LANGUAGES.map((l) => l.id).sort(), 'ni un lenguaje de más ni de menos');
  for (const l of TESTED_LANGUAGES) for (const s of l.samples) assert.ok(cf().isCode(s), `${s} es código`);
});

test('Guardiana_NingunRevisorDelNucleoSeQuedaAtras', () => {
  const ahora = faltantes();
  const conocidos = JSON.parse(fs.readFileSync(REGISTRO, 'utf8')).faltantes;
  const nuevos = [];
  const resueltos = [];
  // un revisor registrado «sin declarar» está en camino: mientras se alinea por partes, lo que le falta avisa
  const enCamino = (rev) => (conocidos[rev] || []).includes('sin declarar');
  for (const [rev, lista] of Object.entries(ahora)) for (const x of lista) if (!enCamino(rev) && !(conocidos[rev] || []).includes(x)) nuevos.push(`${rev}: ${x}`);
  for (const [rev, lista] of Object.entries(conocidos)) {
    const hoy = ahora[rev] || [];
    if (!hoy.length) { resueltos.push(`${rev}: ya no le falta nada`); continue; }
    for (const x of lista) if (x !== 'sin declarar' && !hoy.includes(x)) resueltos.push(`${rev}: ${x}`);
  }
  const avisos = Object.entries(ahora).filter(([rev]) => conocidos[rev]).flatMap(([rev, lista]) => lista.filter((x) => enCamino(rev) || (conocidos[rev] || []).includes(x)).map((x) => `${rev}: ${x}`));
  if (avisos.length) console.log(`AVISO — revisores del núcleo que todavía no cubren todos los lenguajes (${avisos.length}):\n  ${avisos.join('\n  ')}`);
  const reg = path.relative(RAIZ, REGISTRO);
  assert.deepStrictEqual(nuevos, [], `un revisor del núcleo se quedó atrás (no está en ${reg}): cubrí el lenguaje, o declaralo con su motivo`);
  assert.deepStrictEqual(resueltos, [], `ya no faltan: sacalos de ${reg} en este mismo commit (si quedaran, una regresión posterior no frenaría)`);
});
