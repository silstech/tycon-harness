'use strict';
/**
 * bash-version.js — la versión de un bash, para las pruebas que se saltean fuera de la referencia (zsh + bash 3.2).
 *
 * Una sola lectura para todas: `bash --version` escribe su encabezado traducido según el idioma de la máquina
 * («GNU bash, versión 5.2.21» con LANG=es_ES.UTF-8 en Ubuntu), y una expresión que busca «version» no la encuentra.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { idiomaFijo } = require(path.join(__dirname, '..', '..', 'lib', 'clean-git-env.js'));

/**
 * La versión «mayor.menor» del bash de `bin` (por defecto /bin/bash), o null si no corre o no se entiende. Corre con el
 * idioma fijo (LC_ALL=C, sin LANGUAGE ni LC_MESSAGES): el encabezado sale en inglés en cualquier máquina.
 */
function versionDeBash(bin = '/bin/bash', env = process.env) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: idiomaFijo(env) });
  const m = /version (\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

module.exports = { versionDeBash };
