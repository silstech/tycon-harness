'use strict';
// site-plurals.test.js — un texto del sitio con una cantidad dice el singular cuando la cantidad es 1.
//
// 🔴 Falla con: «open: 1 missing» / «abierta: faltan 1» (recorrido del sitio del 27/11). La tabla de textos acepta una
// forma `uno` que sale cuando `n` es 1, sin cambiar a quien llama. Las claves que tienen su singular aparte (por ejemplo
// `arnes.bancoRojosDeUno`) lo eligen en quien llama y no la necesitan.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TX = require(path.join(__dirname, '..', 'site', 'texts.js'));

test('P1 Singular_ConNIgualAUno — en los dos idiomas', () => {
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: 1 }), 'abierta: falta 1');
  assert.strictEqual(TX.t('en', 'proyectos.est.abierta', { n: 1 }), 'open: 1 left');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: '1' }), 'abierta: falta 1', 'también si llega como texto');
});

test('P2 Plural_ConOtraCantidad — el plural de siempre, también con «?»', () => {
  assert.strictEqual(TX.t('en', 'proyectos.est.abierta', { n: '?' }), 'open: ? left');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: 0 }), 'abierta: faltan 0');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: 3 }), 'abierta: faltan 3');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', {}), 'abierta: faltan {n}', 'sin cantidad, el texto con su hueco');
});

test('P3 FormaUno_BienFormada — trae los dos idiomas y sólo la usa una clave con {n}', () => {
  for (const [k, e] of Object.entries(TX.TEXTOS)) {
    if (!e || !e.uno) continue;
    assert.ok(typeof e.uno.es === 'string' && typeof e.uno.en === 'string', `${k}: la forma uno en los dos idiomas`);
    assert.ok(e.es.includes('{n}') && e.en.includes('{n}'), `${k}: la forma uno sólo tiene sentido si el texto lleva {n}`);
  }
});
