'use strict';
/**
 * reviewer-notes.js — las notas que un paquete le deja a un revisor del núcleo.
 * Casos: tests/reviewer-notes.test.js.
 *
 * POR QUÉ EXISTE. Un revisor del núcleo sirve para cualquier organización y cualquier lenguaje. Lo que es de un stack
 * (el logger de un framework que no tiene BeginScope, la forma de las rutas de un host) no va en su texto: va en el
 * paquete de ese stack. Un paquete trae `reviewer-notes/<revisor>.md`, y cuando está activo en el repo, la nota entra
 * al contexto de la vuelta de revisores (el compartido y los recortados por revisor). La nota dice cómo se aplican las
 * reglas de ese revisor en el stack del paquete: equivalentes, excepciones del framework, ejemplos. No trae reglas con
 * un ID propio ni saca las del revisor: un paquete que necesita una regla nueva la pone en un revisor suyo.
 *
 * Una nota para un revisor que no es del núcleo (o que es del mismo paquete), vacía, más grande que el tope, o un
 * archivo que no es `<revisor>.md` es un paquete roto: frena como cualquier otro error del paquete. Descartarla en
 * silencio dejaría al revisor sin saber lo del stack, y eso no da error: da hallazgos falsos.
 */

const fs = require('fs');
const path = require('path');

const CARPETA = 'reviewer-notes';
// Una nota cuenta cómo se ven unas reglas en un stack, no reescribe el revisor: con más que esto, va a un revisor propio
const TOPE_BYTES = 16 * 1024;
const NOMBRE = /^([a-z0-9][a-z0-9-]*)\.md$/;
// Los revisores del núcleo que no corren con el contexto de una vuelta ni con un pedido que el pipeline arme: una nota
// para ellos no llegaría nunca, y validarla en silencio sería peor que rechazarla
const NO_RECIBEN = Object.freeze({
  'tycon-retrospective-capturer': 'corre después del merge, fuera de la ejecución',
  'tycon-signed-scope-audit': 'se lanza a mano, contra la propuesta firmada, sin el contexto de una vuelta',
});
// Revisores del núcleo que no están en el set de la vuelta pero sí reciben notas: el revisor adversarial de la historia
// las recibe en el pedido que arma `pipeline.js validators`. El instalador cuenta todo `agents/` como núcleo y el
// pipeline sólo el set; con esto los dos aceptan lo mismo
const FUERA_DEL_SET = Object.freeze(['tycon-story-adversarial-reviewer']);
// Lo que el sistema operativo deja solo en una carpeta: se ignora, no rompe el paquete
const DEL_SISTEMA = /^(\..*|Thumbs\.db|desktop\.ini)$/i;

/** Los archivos de la carpeta de notas de un paquete ([] si no tiene carpeta). */
function entradas(dirPaquete) {
  const dir = path.join(dirPaquete, CARPETA);
  let nombres;
  try { nombres = fs.readdirSync(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    return [{ ruta: dir, error: `no se pudo leer la carpeta de notas (${(e && e.code) || e.message})` }];
  }
  return nombres.filter((n) => !DEL_SISTEMA.test(n)).sort().map((n) => ({ nombre: n, ruta: path.join(dir, n) }));
}

/**
 * Los errores de las notas de un paquete, con la forma de los del manifiesto: `[{ archivo, revisor, motivo }]`.
 * `nucleo`: los revisores del núcleo (vacío = no se puede comprobar el nombre y no se comprueba). `propios`: los
 * revisores que declara el mismo paquete.
 */
function validarNotas(dirPaquete, { nucleo = [], propios = [] } = {}) {
  const errores = [];
  for (const e of entradas(dirPaquete)) {
    if (e.error) { errores.push({ archivo: e.ruta, revisor: null, motivo: e.error }); continue; }
    const m = NOMBRE.exec(e.nombre);
    // lstat: un enlace no se sigue (una nota enlazada leería un archivo de afuera del paquete)
    let st = null;
    try { st = fs.lstatSync(e.ruta); } catch (_e) { st = null; }
    if (st && st.isSymbolicLink()) {
      errores.push({ archivo: e.ruta, revisor: m ? m[1] : null, motivo: 'es un enlace: una nota es un archivo del paquete, no apunta a otro' });
      continue;
    }
    if (!m || !st || !st.isFile()) {
      errores.push({ archivo: e.ruta, revisor: null, motivo: `no es una nota: en ${CARPETA}/ va un <revisor del núcleo>.md por revisor` });
      continue;
    }
    const revisor = m[1];
    if (propios.includes(revisor)) {
      errores.push({ archivo: e.ruta, revisor, motivo: `«${revisor}» es un revisor de este mismo paquete: lo que necesita va en sus instrucciones, no en una nota` });
      continue;
    }
    if (NO_RECIBEN[revisor]) {
      errores.push({ archivo: e.ruta, revisor, motivo: `«${revisor}» no recibe notas: ${NO_RECIBEN[revisor]}` });
      continue;
    }
    const validos = nucleo.length ? recibenNotas(nucleo) : [];
    if (validos.length && !validos.includes(revisor)) {
      errores.push({ archivo: e.ruta, revisor, motivo: `«${revisor}» no es un revisor del núcleo que reciba notas (son: ${validos.join(', ')})` });
      continue;
    }
    const bytes = st.size;
    if (bytes > TOPE_BYTES) {
      errores.push({ archivo: e.ruta, revisor, motivo: `la nota es más grande que el tope (${bytes} bytes; van hasta ${TOPE_BYTES}): lo que no entra va en un revisor del paquete` });
      continue;
    }
    if (!fs.readFileSync(e.ruta, 'utf8').trim()) errores.push({ archivo: e.ruta, revisor, motivo: 'la nota está vacía' });
  }
  return errores;
}

/** Las notas de un paquete ya validado: `[{ revisor, ruta }]`, en orden de nombre. */
function listarNotas(dirPaquete) {
  return entradas(dirPaquete).filter((e) => !e.error && NOMBRE.test(e.nombre)).map((e) => ({ revisor: NOMBRE.exec(e.nombre)[1], ruta: e.ruta }));
}

/** Las notas para UN revisor de los paquetes dados: `[{ paquete, revisor, ruta }]`. */
function notasPara(paquetes, revisor) {
  const out = [];
  for (const p of paquetes || []) for (const n of p.notas || []) if (n.revisor === revisor) out.push({ paquete: p.nombre, ...n });
  return out;
}

/**
 * El bloque que va al contexto de la vuelta con las notas de los paquetes dados (los ACTIVOS en el repo, como los
 * devuelve packs.js), por revisor y después por paquete. Con `revisor`, sólo las suyas (el pedido de un revisor que
 * se lanza fuera de la vuelta). Sin notas, '' (el contexto queda byte a byte igual).
 */
function bloqueDeNotas(paquetes, { revisor } = {}) {
  const todas = [];
  for (const p of paquetes || []) for (const n of p.notas || []) if (!revisor || n.revisor === revisor) todas.push({ paquete: p.nombre, ...n });
  if (!todas.length) return '';
  todas.sort((a, b) => a.revisor.localeCompare(b.revisor) || a.paquete.localeCompare(b.paquete));
  const out = [
    '## Notas de los paquetes para los revisores del núcleo',
    '',
    'Cada nota es de un paquete activo en este repo y le habla a UN revisor. Si sos ese revisor, aplicá tus reglas con lo',
    'que dice: cómo se ven en este stack, sus equivalentes y las excepciones del framework. No suma reglas con un ID propio',
    'ni saca las tuyas. Si no sos ese revisor, ignorala.',
    '',
  ];
  for (const n of todas) {
    out.push(`### Para \`${n.revisor}\` — paquete \`${n.paquete}\``, '', fs.readFileSync(n.ruta, 'utf8').trim(), '');
  }
  out.push('');
  return out.join('\n');
}

/** Los revisores del núcleo que reciben notas, dado el núcleo del pipeline. */
function recibenNotas(nucleo) {
  return [...new Set([...(nucleo || []), ...FUERA_DEL_SET])].filter((r) => !NO_RECIBEN[r]);
}

module.exports = { CARPETA, TOPE_BYTES, NO_RECIBEN, FUERA_DEL_SET, recibenNotas, validarNotas, listarNotas, notasPara, bloqueDeNotas };
