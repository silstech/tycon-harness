'use strict';
/**
 * bash-version-language.test.js — la versión de bash se lee igual en cualquier idioma de la máquina.
 *
 * Caso que lo motiva: en Ubuntu 24.04 con LANG=es_ES.UTF-8 y LC_ALL sin poner, `bash --version` dice «versión», con
 * tilde. Las pruebas que se saltean fuera de la referencia (zsh + bash 3.2) no encontraban la versión, no se salteaban
 * y fallaban en Linux (G11 y MOD1 de prod-guard-shell-forms).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { versionDeBash } = require('./lib/bash-version.js');

const ROOT = path.resolve(__dirname, '..', '..');

// un bash de mentira que traduce como gettext: LC_ALL manda, después LC_MESSAGES y después LANG; LANGUAGE sólo cuenta
// fuera de C
function bashQueTraduce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-idioma-'));
  const bin = path.join(dir, 'bash');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'loc="${LC_ALL:-${LC_MESSAGES:-${LANG:-C}}}"',
    'case "$loc" in C|C.*|POSIX) lang=C ;; *) lang="${LANGUAGE:-$loc}" ;; esac',
    'case "$lang" in es*) echo "GNU bash, versión 5.2.21(1)-release (x86_64-pc-linux-gnu)" ;;',
    '  *) echo "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)" ;; esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, dir };
}

// 🔴 Falla con: la versión leída con el idioma de la máquina (LANG=es_ES.UTF-8 y LC_ALL sin poner da «versión» y la
//    lectura vuelve null), o con LANGUAGE=es pisando un LC_ALL que no es C.
test('A225 BashVersion_SpanishLocale_StillReadsVersion — con LANG o LANGUAGE en castellano, la versión se lee', { skip: process.platform === 'win32' && 'sin /bin/sh' }, () => {
  const { bin, dir } = bashQueTraduce();
  try {
    const base = { PATH: process.env.PATH, HOME: dir };
    assert.strictEqual(versionDeBash(bin, { ...base, LANG: 'es_ES.UTF-8' }), '5.2', 'LANG en castellano y LC_ALL sin poner');
    assert.strictEqual(versionDeBash(bin, { ...base, LANG: 'es_AR.UTF-8', LANGUAGE: 'es' }), '5.2', 'con LANGUAGE');
    assert.strictEqual(versionDeBash(bin, { ...base, LC_ALL: 'es_ES.UTF-8' }), '5.2', 'con LC_ALL en castellano');
    assert.strictEqual(versionDeBash(bin, { ...base, LC_MESSAGES: 'es_ES.UTF-8' }), '5.2', 'con LC_MESSAGES');
    assert.strictEqual(versionDeBash(path.join(dir, 'no-existe'), base), null, 'un bash que no está da null');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 🔴 Falla con: una prueba que vuelve a leer la versión de bash por su cuenta, con la expresión que busca «version»
//    sobre la salida en el idioma de la máquina, en vez de usar lib/bash-version.js.
test('A225 BashVersion_EveryReader_UsesTheSharedReader — ninguna prueba lee la versión de bash por su cuenta', () => {
  const carpetas = [path.join(ROOT, 'scripts', 'tests'), path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'tests')];
  const propio = new Set([path.join(ROOT, 'scripts', 'tests', 'lib', 'bash-version.js'), __filename]);
  const malos = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') recorrer(p); continue; }
      if (!/\.(js|sh)$/.test(e.name) || propio.has(p)) continue;
      const t = fs.readFileSync(p, 'utf8');
      // `bash --version` leído con una expresión o un grep, sin fijar el idioma en la misma línea
      t.split('\n').forEach((l, i) => {
        const lee = /bash['"]?,?\s*\[?\s*['"]?--version/.test(l) || /\/version \(\\d/.test(l);
        const fijo = /LC_ALL=C|idiomaFijo|versionDeBash/.test(l);
        if (lee && !fijo && !/^\s*(\/\/|\*|#)/.test(l)) malos.push(`${path.relative(ROOT, p)}:${i + 1}`);
      });
    }
  };
  carpetas.forEach(recorrer);
  assert.deepStrictEqual(malos, [], 'leen la versión de bash sin fijar el idioma');
});
