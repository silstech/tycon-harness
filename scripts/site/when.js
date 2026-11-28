'use strict';
/**
 * when.js — un momento para las páginas del sitio, en la hora de quien mira.
 *
 * El servidor no sabe en qué hora está quien mira: manda cada momento como una etiqueta <time> con el instante en UTC
 * (el atributo `datetime`) y la forma en que se dice (`data-forma`). Adentro va el texto en UTC con su marca, que es lo
 * que ve un navegador sin guiones. `static/site.js` lo pasa a la hora y al idioma de quien mira, con un solo formato
 * para todo el sitio (el mes en letras: el día y el mes nunca se confunden).
 */

/** Las formas de decir un momento: con día y hora, sólo el día, sólo la hora, o el día sin el año. */
const FORMAS = Object.freeze(['fechaHora', 'fecha', 'hora', 'diaMes']);

/** El instante de un valor (milisegundos, `Date` o texto ISO), o null si no se lee. */
function instante(valor) {
  if (valor instanceof Date) return Number.isFinite(valor.getTime()) ? valor.getTime() : null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'string' && valor.trim()) {
    const ms = Date.parse(valor);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** El texto en UTC de un instante, con su marca: el que queda si el navegador no corre guiones. */
function textoUtc(ms, forma) {
  const iso = new Date(ms).toISOString();
  const dia = iso.slice(0, 10);
  const hora = iso.slice(11, 16);
  if (forma === 'hora') return `${hora} UTC`;
  if (forma === 'fecha' || forma === 'diaMes') return `${dia} UTC`;
  return `${dia} ${hora} UTC`;
}

/**
 * La etiqueta <time> de un momento. Sin un instante que se lea, devuelve '' (quien llama decide qué decir en su
 * lugar). Una forma que no está en FORMAS es un error de quien llama.
 */
function momento(valor, { forma = 'fechaHora' } = {}) {
  if (!FORMAS.includes(forma)) throw new TypeError(`when.js: forma desconocida «${forma}»`);
  const ms = instante(valor);
  if (ms === null) return '';
  return `<time datetime="${new Date(ms).toISOString()}" data-forma="${forma}">${textoUtc(ms, forma)}</time>`;
}

// Un momento dentro de un texto que después se escapa: la marca lleva el instante en UTC y la forma, entre dos
// caracteres de control que el escape no toca. `conMomentos` la cambia por la etiqueta <time> sobre el HTML ya
// escapado. Va sólo en texto visible, nunca en un atributo.
const SEP = '\u0001';
const MARCA = /\u0001([0-9A-Za-z:.+-]+)\|([A-Za-z]+)\u0001/g;

/** La marca de un momento para meter en un texto, o '' si el valor no es un instante que se lea. */
function marca(valor, forma = 'fechaHora') {
  if (!FORMAS.includes(forma)) throw new TypeError(`when.js: forma desconocida «${forma}»`);
  const ms = instante(valor);
  return ms === null ? '' : `${SEP}${new Date(ms).toISOString()}|${forma}${SEP}`;
}

/**
 * La marca si el valor trae la hora (un instante); si es un día solo («AAAA-MM-DD»), el día tal como vino: un día del
 * calendario no se pasa a la hora de quien mira, porque se correría al día anterior o al siguiente.
 */
function marcaSiTieneHora(valor, forma = 'fecha') {
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) return valor.trim();
  return marca(valor, forma) || (valor == null ? '' : String(valor));
}

/** El HTML con cada marca cambiada por su etiqueta <time>; una marca con un instante que no se lee, se borra. */
function conMomentos(html) {
  return String(html).replace(MARCA, (m, iso, forma) => (FORMAS.includes(forma) ? momento(iso, { forma }) : ''));
}

// Un día del calendario («AAAA-MM-DD», el que anotó una máquina) no es un instante: se dice con el mismo formato que
// los momentos del sitio, pero sin pasarlo a ninguna zona. El servidor lo arma en UTC, así el día nunca se corre.
const FORMAS_DE_DIA = Object.freeze({
  diaMes: { day: 'numeric', month: 'short', timeZone: 'UTC' },
  fecha: { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' },
});

/** Un día en el idioma de la página («27 nov», «Nov 27»; con `fecha`, con el año); lo que no es un día queda como vino. */
function textoDia(dia, idioma, forma = 'diaMes') {
  const opciones = FORMAS_DE_DIA[forma];
  if (!opciones) throw new TypeError(`when.js: forma de día desconocida «${forma}»`);
  const s = String(dia == null ? '' : dia);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(idioma === 'en' ? 'en' : 'es', opciones).format(d) : s;
}

module.exports = { momento, marca, marcaSiTieneHora, conMomentos, textoDia, instante, textoUtc, FORMAS };
