'use strict';

/**
 * code-files.js — qué archivo es código, cuál es una prueba y qué marca deja una prueba salteada. Una sola respuesta
 * para todos los controles del pipeline.
 *
 * Dos preguntas distintas a propósito:
 *   - `isSource`: archivo fuente de un lenguaje (lo que el portón ATDD pide probar antes de escribir).
 *   - `isCode`: además los guiones `.sh` y los proyectos `.csproj`, que no son lenguajes pero cambian lo que corre.
 * Cada control que cuenta algo más (el portón de carril suma `.sql` y `.css`; el contexto de los revisores suma `.json`)
 * lo suma encima de estas, nunca en una lista propia.
 *
 * La organización suma extensiones en `team-repos.json → stack.code_extensions` (lo lee `stack-config.js`); quien
 * pregunta las pasa como `{ extra }`. No puede sacar las del núcleo.
 */

const path = require('path');

const SOURCE_EXTS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.cs', '.py', '.go', '.rb', '.java', '.kt', '.swift', '.rs',
  '.vue', '.svelte',
]);
const SOURCE_SET = new Set(SOURCE_EXTS);
const CODE_ONLY_EXTS = Object.freeze(['.sh', '.csproj']);
const CODE_SET = new Set([...SOURCE_EXTS, ...CODE_ONLY_EXTS]);
/** El lenguaje de cada terminación de arriba, para decirle a una persona qué reconoce el arnés (el sitio la muestra). */
const LANGUAGES = Object.freeze({
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.cs': 'C# (.NET)', '.csproj': '.NET (proyecto)', '.py': 'Python', '.go': 'Go', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.rs': 'Rust', '.vue': 'Vue', '.svelte': 'Svelte', '.sh': 'Shell',
});

/**
 * Los lenguajes que el núcleo sabe probar: cada herramienta de prueba de fábrica de test-runners.js declara el suyo
 * (`language`), y bash lo prueban las suites del arnés. Todo revisor del núcleo que mira código cubre estos lenguajes;
 * cada uno lo declara en su texto (`<!-- lenguajes: … -->`) y reviewer-lists.test.js lo compara con esta lista y con
 * su disparo. `samples`: archivos de ese lenguaje con los que un revisor tiene que poder lanzarse (alcanza uno).
 */
const TESTED_LANGUAGES = Object.freeze([
  { id: 'csharp', name: 'C#', samples: ['src/Pedido.cs', 'tests/PedidoTests.cs'] },
  { id: 'typescript', name: 'TypeScript/JavaScript', samples: ['src/pedido.ts', 'src/pedido.test.ts', 'e2e/pedido.spec.ts'] },
  { id: 'python', name: 'Python', samples: ['app/pedido.py', 'tests/test_pedido.py'] },
  { id: 'go', name: 'Go', samples: ['pedido.go', 'pedido_test.go'] },
  { id: 'java-kotlin', name: 'Java/Kotlin', samples: ['src/main/java/Pedido.java', 'src/main/kotlin/Pedido.kt', 'src/test/java/PedidoTest.java'] },
  { id: 'rust', name: 'Rust', samples: ['src/pedido.rs', 'tests/pedido.rs'] },
  { id: 'bash', name: 'bash', samples: ['scripts/despliegue.sh', 'tests/despliegue.test.sh'] },
]);
/** Las terminaciones agrupadas por lenguaje, en el orden de las listas: `[{ language, exts }]`. */
function byLanguage() {
  const out = [];
  for (const e of [...SOURCE_EXTS, ...CODE_ONLY_EXTS]) {
    const language = LANGUAGES[e] || e;
    const g = out.find((x) => x.language === language);
    if (g) g.exts.push(e); else out.push({ language, exts: [e] });
  }
  return out;
}

/** La forma de una extensión que la organización puede sumar: punto, minúsculas, letras o números. */
const EXT_RE = /^\.[a-z0-9]+(?:\.[a-z0-9]+)?$/;

function extOf(f) {
  return path.extname(String(f || '').replace(/\\/g, '/')).toLowerCase();
}

/** Por la terminación completa, no por `path.extname`: una extensión de dos tramos (`.blade.php`) también calza. */
function inExtra(f, extra) {
  if (!Array.isArray(extra) || !extra.length) return false;
  const s = String(f || '').toLowerCase();
  return extra.some((e) => typeof e === 'string' && s.endsWith(e));
}

/** ¿Archivo fuente de un lenguaje? `extra`: las extensiones que sumó la organización. */
function isSource(f, { extra } = {}) {
  return SOURCE_SET.has(extOf(f)) || inExtra(f, extra);
}

/** ¿Código? Fuente, guion `.sh` o proyecto `.csproj`. */
function isCode(f, { extra } = {}) {
  return CODE_SET.has(extOf(f)) || inExtra(f, extra);
}

/**
 * ¿Archivo de prueba? Por nombre: `.test.`/`.spec.` (JS/TS y suites bash), `*Tests.cs`, `test_*.py`, `*_test.py`,
 * `*_test.go`, `*Test.java`/`*Tests.kt`, `*_spec.rb`/`*_test.rb` y `*Tests.swift`. Por carpeta: todo `.py` bajo una
 * carpeta `tests/` (pytest junta ahí sus ayudantes y `conftest.py`) y todo `.rs` bajo `tests/` (las de integración de Rust).
 */
function isTestFile(f) {
  const s = String(f || '').replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/\.(test|spec)\.sh$/i.test(base)) return true;
  if (/Tests?\.cs$/.test(base)) return true;
  if (/^test_[^/]*\.py$/i.test(base) || /_test\.py$/i.test(base)) return true;
  if (/_test\.go$/i.test(base)) return true;
  if (/Tests?\.(java|kt)$/.test(base)) return true;
  if (/_(spec|test)\.rb$/i.test(base) || /^test_[^/]*\.rb$/i.test(base)) return true;
  if (/Tests?\.swift$/.test(base)) return true;
  if (/\.py$/i.test(base) && /(^|\/)tests\//.test(s)) return true;
  // Rust: las de integración viven en `tests/`; las unitarias van dentro del mismo archivo (`#[cfg(test)]`)
  if (/\.rs$/i.test(base) && /(^|\/)tests\//.test(s)) return true;
  return false;
}

/**
 * Las marcas de prueba salteada, por lenguaje: la única lista. El texto del revisor de lo diferido nombra cada marca
 * (lo compara reviewer-lists.test.js). `exts: null` vale en cualquier archivo de prueba; las demás, sólo en las
 * terminaciones de su lenguaje, porque fuera de él son otra cosa (`t.Skip(` es LINQ en C#, `skip` es una palabra
 * común). `example` es un nombre de archivo de prueba de ese lenguaje.
 */
const SKIP_MARKS = Object.freeze([
  { language: 'JavaScript/TypeScript (Jest, Vitest, Mocha, Playwright)', exts: null, example: 'pedido.test.ts',
    marks: ['it.skip(', 'test.skip(', 'describe.skip(', 'xit(', 'xdescribe('], re: /\b(?:it|test|describe)\.skip\(|\bx(?:it|describe)\(/ },
  { language: 'C# (xUnit)', exts: null, example: 'PedidoTests.cs',
    marks: ['[Fact(Skip =', '[Theory(Skip ='], re: /\[Fact\(Skip\s*=|\[Theory\(Skip\s*=/ },
  { language: 'Python (pytest, unittest)', exts: null, example: 'tests/test_pedido.py',
    marks: ['@pytest.mark.skip', 'pytest.skip(', '@unittest.skip'], re: /@pytest\.mark\.skip\b|\bpytest\.skip\(|@unittest\.skip\b/ },
  { language: 'Go', exts: ['.go'], example: 'pedido_test.go',
    marks: ['t.Skip(', 't.SkipNow(', 't.Skipf('], re: /\bt\.Skip(?:Now|f)?\(/ },
  { language: 'Java y Kotlin (JUnit)', exts: ['.java', '.kt'], example: 'src/test/java/PedidoTest.java',
    marks: ['@Disabled', '@Ignore'], re: /@(?:Disabled|Ignore)\b/ },
  // `skip`/`pending` al empezar el renglón son llamadas; seguidos de `:` o `=` son una clave o una variable, no una marca
  { language: 'Ruby (RSpec, Minitest)', exts: ['.rb'], example: 'spec/pedido_spec.rb',
    marks: ['xit', 'xdescribe', 'xcontext', 'xspecify', 'skip', 'pending', 'skip:', ':skip'],
    re: /^\s*(?:xit|xdescribe|xcontext|xspecify)\b|^\s*(?:skip|pending)\b(?!\s*[:=])|^\s*(?:it|specify|example|describe|context)\b.*(?:\bskip:|,\s*:skip\b)|^skip:|^:skip$/m },
  { language: 'Swift (XCTest)', exts: ['.swift'], example: 'PedidoTests.swift',
    marks: ['XCTSkip(', 'XCTSkipIf(', 'XCTSkipUnless('], re: /\bXCTSkip(?:If|Unless)?\(/ },
  { language: 'Rust (cargo test)', exts: ['.rs'], example: 'tests/pedido.rs',
    marks: ['#[ignore]'], re: /#\[ignore\b/ },
]);
/** Las marcas que valen en cualquier archivo de prueba, en una sola expresión. */
const SKIP_MARK_RE = new RegExp(SKIP_MARKS.filter((g) => !g.exts).map((g) => g.re.source).join('|'));
const GO_SKIP_MARK_RE = SKIP_MARKS.find((g) => g.language === 'Go').re;

/**
 * ¿Puede traer una prueba salteada? Un archivo de prueba, o un `.rs`: en Rust las pruebas unitarias viven dentro del
 * mismo archivo que el código (`#[cfg(test)]`), y su `#[ignore]` sólo se ve leyéndolo.
 */
function mayHaveSkips(f) {
  return isTestFile(f) || extOf(f) === '.rs';
}

/** ¿El contenido de este archivo de prueba trae una marca de prueba salteada? Cada marca, en los archivos de su lenguaje. */
function hasSkipMark(content, file) {
  const c = String(content || '');
  const ext = extOf(file);
  return SKIP_MARKS.some((g) => (!g.exts || g.exts.includes(ext)) && g.re.test(c));
}

/**
 * Una prueba de punta a punta: una de estas terminaciones bajo una de estas carpetas, o bajo la que el repo declara en
 * `.tycon/advisors.yaml → e2e.specs_dir`. Una `.spec.ts` fuera de ellas es una prueba unitaria. El texto del revisor de
 * pruebas de punta a punta nombra las dos listas (lo compara reviewer-lists.test.js).
 */
const E2E_SPEC_EXTS = Object.freeze(['.spec.ts', '.spec.tsx', '.spec.js', '.spec.mjs', '.spec.cjs']);
const E2E_DIRS = Object.freeze(['e2e', 'playwright']);

/** ¿Prueba de punta a punta? `specsDir`: la carpeta que declara el repo, relativa a su raíz. */
function isE2eSpec(f, { specsDir } = {}) {
  const s = String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!E2E_SPEC_EXTS.some((e) => s.toLowerCase().endsWith(e))) return false;
  const carpetas = s.split('/').slice(0, -1);
  // las de Cypress tienen su propio formato: este revisor es de Playwright
  if (carpetas.includes('cypress')) return false;
  if (typeof specsDir === 'string' && specsDir.trim()) {
    const dir = specsDir.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    // `.` es todo el repo; la ruta puede venir con el repo adelante (absoluta o de un repo hermano)
    if (dir === '' || dir === '.' || s.startsWith(`${dir}/`) || s.includes(`/${dir}/`)) return true;
  }
  return carpetas.some((c) => E2E_DIRS.includes(c));
}

/**
 * Valida `stack.code_extensions` tal como viene del archivo. Devuelve `{ extra, problems }`: con cualquier problema la
 * ampliación entera no se usa (una lista a medias es peor que ninguna) y cada problema lleva la ruta de su clave.
 */
function parseExtensions(value, base = 'stack.code_extensions') {
  if (value === undefined) return { extra: [], problems: [] };
  if (!Array.isArray(value)) return { extra: [], problems: [{ path: base, message: 'tiene que ser una lista de terminaciones, por ejemplo [".ex"]' }] };
  const problems = [];
  const vistos = new Set();
  value.forEach((v, i) => {
    if (typeof v !== 'string' || !EXT_RE.test(v)) {
      problems.push({ path: `${base}[${i}]`, message: `cada terminación va con punto y en minúsculas, por ejemplo ".ex" (es ${JSON.stringify(v)})` });
    } else if (vistos.has(v)) {
      problems.push({ path: `${base}[${i}]`, message: `${v} está repetida` });
    }
    vistos.add(v);
  });
  return problems.length ? { extra: [], problems } : { extra: value.slice(), problems: [] };
}

module.exports = { SOURCE_EXTS, CODE_ONLY_EXTS, LANGUAGES, TESTED_LANGUAGES, byLanguage, EXT_RE, isSource, isCode, isTestFile, SKIP_MARKS, SKIP_MARK_RE, GO_SKIP_MARK_RE, mayHaveSkips, hasSkipMark, E2E_SPEC_EXTS, E2E_DIRS, isE2eSpec, parseExtensions, extOf };
