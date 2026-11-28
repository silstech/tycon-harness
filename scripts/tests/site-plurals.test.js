'use strict';
// site-plurals.test.js — un texto del sitio con una cantidad dice el singular cuando la cantidad es 1.
//
// 🔴 Falla con: «1 red cases, out of 10», «1 work items», «open: 1 missing» / «abierta: faltan 1» (recorrido del sitio
// del 27/11). La tabla de textos acepta una forma `uno` que sale cuando `n` es 1; quien llama no cambia.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const TX = require(path.join(__dirname, '..', 'site', 'texts.js'));

test('P1 Singular_ConNIgualAUno — en los dos idiomas', () => {
  assert.strictEqual(TX.t('en', 'arnes.bancoRojosDe', { n: 1, total: 10, fecha: '2026-11-27' }), '1 red case, out of 10 (from 2026-11-27)');
  assert.strictEqual(TX.t('es', 'arnes.bancoRojosDe', { n: 1, total: 10, fecha: '2026-11-27' }), '1 caso rojo, de 10 (del 2026-11-27)');
  assert.strictEqual(TX.t('en', 'mant.marcha.tareas', { n: 1 }), '1 work item');
  assert.strictEqual(TX.t('es', 'mant.marcha.tareas', { n: 1 }), '1 tarea');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: 1 }), 'abierta: falta 1');
  assert.strictEqual(TX.t('en', 'proyectos.est.abierta', { n: 1 }), 'open: 1 left');
});

test('P2 Plural_ConOtraCantidad — el plural de siempre, también con «?»', () => {
  assert.strictEqual(TX.t('en', 'arnes.bancoRojosDe', { n: 3, total: 10, fecha: 'x' }), '3 red cases, out of 10 (from x)');
  assert.strictEqual(TX.t('en', 'mant.marcha.tareas', { n: 2 }), '2 work items');
  assert.strictEqual(TX.t('en', 'proyectos.est.abierta', { n: '?' }), 'open: ? left');
  assert.strictEqual(TX.t('es', 'proyectos.est.abierta', { n: 0 }), 'abierta: faltan 0');
});

test('P3 FormaUno_BienFormada — trae los dos idiomas y sólo la usa una clave con {n}', () => {
  for (const [k, e] of Object.entries(TX.TEXTOS)) {
    if (!e || !e.uno) continue;
    assert.ok(typeof e.uno.es === 'string' && typeof e.uno.en === 'string', `${k}: la forma uno en los dos idiomas`);
    assert.ok(e.es.includes('{n}') && e.en.includes('{n}'), `${k}: la forma uno sólo tiene sentido si el texto lleva {n}`);
  }
});
