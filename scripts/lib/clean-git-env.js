'use strict';
/**
 * clean-git-env.js —el git de un sandbox no puede terminar escribiendo en el repo de verdad.
 *
 * 🔴 QUÉ EVITA. Un chequeo del pre-commit (como `advisor-liveness-on-change.js`) que arma un fixture con
 * `git init && git add -A && git commit -qm fixture` sin este env escribe SOBRE LA RAMA DEL DEV: deja commits
 * `fixture` en la punta y reemplaza el árbol del repo por el del fixture. Se recupera con `git reset`, pero el
 * trabajo queda a un `git gc` de ser irrecuperable.
 *
 * POR QUÉ. git le exporta a sus hooks `GIT_DIR`, `GIT_INDEX_FILE` y compañía. Cualquier `git` que
 * un hook lance las hereda, y esas variables GANAN sobre el `cwd`: `git init` crea el repo del
 * sandbox, y el `git add` siguiente igual escribe en el índice que dice `GIT_INDEX_FILE`. Por eso
 * no se ve nunca en un checkout normal —ahí `GIT_DIR` vale `.git`, relativo, y con `cwd` en el
 * sandbox apunta al `.git` del sandbox— y sí se ve desde un worktree, donde es absoluto.
 *
 * LA REGLA. Todo comando que un script del arnés corra DENTRO de un sandbox va con este env: el
 * `cwd` tiene que ser la única cosa que decide sobre qué repo se opera.
 *
 * LA SEGUNDA REGLA. Todo git cuyo error el arnés lee por el texto va con el idioma fijo (`idiomaFijo`): git traduce sus
 * mensajes según el idioma de la máquina, y «not a git repository» en castellano es «no es un repositorio git». Que
 * nadie la olvide lo mide scripts/tests/git-language-inventory.js. Las dos se componen:
 * `idiomaFijo(sinGitDelPadre(…))`.
 *
 * Sin dependencias: hay pruebas y laboratorios que lo copian solo a su carpeta.
 */

// `GIT_PREFIX` y `GIT_PROTOCOL` no rompen nada pero tampoco significan nada fuera del repo padre.
const DEL_PADRE = [
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_INDEX_VERSION',
  'GIT_QUARANTINE_PATH', 'GIT_PUSH_CERT_NONCE', 'GIT_EDITOR', 'GIT_REFLOG_ACTION',
];

/** Copia de `base` (por defecto, el entorno propio) sin las variables que git le pasa a sus hooks. */
function sinGitDelPadre(...extras) {
  const env = Object.assign({}, process.env, ...extras.filter(Boolean));
  for (const k of DEL_PADRE) delete env[k];
  return env;
}

// git en inglés, en cualquier máquina: el arnés reconoce sus errores por el texto, y gettext traduce según el
// idioma. Con LC_ALL=C gettext no traduce ni mira LANGUAGE; LANG=C cubre a quien lee LANG solo.
const IDIOMA_DE_GIT = Object.freeze({ LC_ALL: 'C', LANG: 'C' });

/** Copia de `base` (por defecto, el entorno propio) con los extras y el idioma de git fijo, que ningún extra pisa. */
function idiomaFijo(base, ...extras) {
  const env = Object.assign({}, base || process.env, ...extras.filter(Boolean), IDIOMA_DE_GIT);
  delete env.LANGUAGE;
  delete env.LC_MESSAGES;
  return env;
}

/**
 * Copia de `base` con configuración de git por el entorno (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>`, desde git 2.31), en vez de `-c clave=valor` en los argumentos: un secreto en los argumentos lo ve
 * cualquier proceso de la máquina (`ps`, `/proc/<pid>/cmdline`) mientras git corre; en el entorno, sólo el dueño del
 * proceso. Tampoco queda en ningún `.git/config`. Los pares se suman a los que ya traía `base` (un proxy o un certificado
 * del servidor), después de ellos: para una clave de un solo valor, git se queda con el último.
 */
function conConfigDeGit(base, pares) {
  const env = Object.assign({}, base || process.env);
  const previos = Number.parseInt(env.GIT_CONFIG_COUNT, 10);
  const desde = Number.isInteger(previos) && previos > 0 ? previos : 0;
  const lista = Object.entries(pares || {});
  lista.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${desde + i}`] = k; env[`GIT_CONFIG_VALUE_${desde + i}`] = String(v); });
  if (lista.length) env.GIT_CONFIG_COUNT = String(desde + lista.length);
  return env;
}

module.exports = { sinGitDelPadre, DEL_PADRE, idiomaFijo, IDIOMA_DE_GIT, conConfigDeGit };
