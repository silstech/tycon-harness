'use strict';
// site-local-time.test.js — todo el sitio en la hora de quien mira, con un solo formato.
//
// 🔴 Falla con: el mismo momento como 27 y como 28 en pestañas distintas, y horas en UTC al lado de horas locales
// (recorrido del sitio del 27/11: «leído 02:00 UTC» al lado de «sin conexión desde 22:18»). El servidor manda cada
// momento como una etiqueta <time> con el instante en UTC y, adentro, el texto en UTC con su marca (lo que ve un
// navegador sin guiones); site.js lo pasa a la hora y el idioma de quien mira, con un solo formato para todo el sitio,
// con el mes en letras para que nunca se confunda el día con el mes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = path.join(__dirname, '..', 'site');
const W = require(path.join(SITE, 'when.js'));
const INSTANTE = Date.UTC(2026, 10, 28, 2, 0); // 28/11 02:00 UTC: en Buenos Aires, el 27 a las 23:00

test('L1 Servidor_MandaElInstanteConSuMarca — <time> con el ISO en UTC y el texto en UTC con «UTC»', () => {
  assert.strictEqual(W.momento(INSTANTE), '<time datetime="2026-11-28T02:00:00.000Z" data-forma="fechaHora">2026-11-28 02:00 UTC</time>');
  assert.strictEqual(W.momento('2026-11-28T02:00:00Z', { forma: 'hora' }), '<time datetime="2026-11-28T02:00:00.000Z" data-forma="hora">02:00 UTC</time>');
  assert.strictEqual(W.momento(INSTANTE, { forma: 'fecha' }), '<time datetime="2026-11-28T02:00:00.000Z" data-forma="fecha">2026-11-28 UTC</time>');
  assert.strictEqual(W.momento(INSTANTE, { forma: 'diaMes' }), '<time datetime="2026-11-28T02:00:00.000Z" data-forma="diaMes">2026-11-28 UTC</time>');
  for (const malo of [null, undefined, '', 'mañana', NaN, {}]) assert.strictEqual(W.momento(malo), '', `sin instante, nada: ${String(malo)}`);
  assert.throws(() => W.momento(INSTANTE, { forma: 'otra' }), /forma/);
});

// el guion del navegador, corrido sin navegador: expone su formateador para la prueba
function formateador() {
  const codigo = fs.readFileSync(path.join(SITE, 'static', 'site.js'), 'utf8');
  const ctx = { document: { documentElement: { setAttribute() {}, removeAttribute() {}, lang: 'es' }, addEventListener() {}, querySelectorAll: () => [] }, localStorage: { getItem: () => null }, Intl, Date };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx);
  assert.strictEqual(typeof ctx.horaLocalDelSitio, 'function', 'site.js expone horaLocalDelSitio');
  return ctx.horaLocalDelSitio;
}

test('L2 Navegador_LoPasaALaHoraDeQuienMira — el 28 a las 02:00 UTC es el 27 a las 23:00 en Buenos Aires', () => {
  const f = formateador();
  const iso = new Date(INSTANTE).toISOString();
  const ba = 'America/Argentina/Buenos_Aires';
  assert.strictEqual(f(iso, 'fechaHora', 'es', ba), '27 nov 2026, 23:00');
  assert.strictEqual(f(iso, 'fecha', 'es', ba), '27 nov 2026');
  assert.strictEqual(f(iso, 'hora', 'es', ba), '23:00');
  assert.strictEqual(f(iso, 'diaMes', 'es', ba), '27 nov');
  assert.strictEqual(f(iso, 'fechaHora', 'en', ba), 'Nov 27, 2026, 23:00');
  assert.strictEqual(f(iso, 'diaMes', 'en', ba), 'Nov 27');
  assert.strictEqual(f(iso, 'hora', 'es', 'UTC'), '02:00', 'en UTC, la misma hora del servidor');
  assert.strictEqual(f('mañana', 'hora', 'es', ba), null, 'un instante que no se lee no cambia el texto');
});

// 🔴 Falla con: un momento metido en un texto que después se escapa queda como texto en UTC. La marca viaja dentro del
// texto (sobrevive al escape) y layout() la cambia por la etiqueta <time> al armar la página.
test('L3 MarcaEnElTexto_SobreviveAlEscapeYSeVuelveEtiqueta — y un día sin hora no se corre de fecha', () => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const texto = `Se rearmó desde ${W.marca(INSTANTE)} <ok>`;
  assert.strictEqual(W.conMomentos(esc(texto)), `Se rearmó desde ${W.momento(INSTANTE)} &lt;ok&gt;`);
  assert.strictEqual(W.marca('mañana'), '', 'sin instante, nada');
  assert.strictEqual(W.conMomentos('sin marcas'), 'sin marcas');
  // un día solo («AAAA-MM-DD») es un día del calendario, no un instante: pasarlo a la hora de quien mira lo correría al
  // día anterior
  assert.strictEqual(W.marcaSiTieneHora('2026-11-28', 'fecha'), '2026-11-28');
  assert.strictEqual(W.conMomentos(W.marcaSiTieneHora('2026-11-28T02:00:00Z', 'fecha')), W.momento(INSTANTE, { forma: 'fecha' }));
  assert.strictEqual(W.conMomentos(W.marcaSiTieneHora(INSTANTE, 'hora')), W.momento(INSTANTE, { forma: 'hora' }));
  assert.strictEqual(W.conMomentos('\u0001no-es-fecha|fecha\u0001'), '', 'una marca con un instante que no se lee no deja basura');
});

test('L4 Pagina_LasBandasEnLaHoraDeQuienMira — sin «UTC» suelto en el texto de la banda', () => {
  const views = require(path.join(SITE, 'views.js'));
  const html = views.layout({ idioma: 'es', bandaRefresco: { desde: new Date(INSTANTE).toISOString(), estado: 'error' } }, 'Inicio', '<p>x</p>');
  const banda = /<div class="banda">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(banda, 'la banda del refresco');
  assert.match(banda[1], /<time datetime="2026-11-28T02:00:00\.000Z" data-forma="fechaHora">2026-11-28 02:00 UTC<\/time>/);
  assert.doesNotMatch(html, /\u0001/, 'ninguna marca queda en la página');
});

// 🔴 Falla con: tres formatos para el mismo día en Horas (día/mes, mes-día y año-mes-día completo), y con los dos
// primeros no se sabe cuál es el mes. Un día del calendario se dice con el mismo formato del sitio (el mes en letras), sin pasarlo
// a ninguna zona: es el día que anotó la máquina.
test('L5 Dia_UnSoloFormato_ConElMesEnLetras — sin correrse de fecha en ninguna zona', () => {
  assert.strictEqual(W.textoDia('2026-11-27', 'es'), '27 nov');
  assert.strictEqual(W.textoDia('2026-11-27', 'en'), 'Nov 27');
  assert.strictEqual(W.textoDia('2026-11-27', 'es', 'fecha'), '27 nov 2026');
  assert.strictEqual(W.textoDia('2026-11-27', 'en', 'fecha'), 'Nov 27, 2026');
  assert.strictEqual(W.textoDia('2026-01-01', 'es'), '1 ene', 'el primero del año no se corre al 31');
  assert.strictEqual(W.textoDia('no es un día', 'es'), 'no es un día', 'lo que no es un día queda como vino');
  const f = formateador();
  assert.strictEqual(W.textoDia('2026-11-27', 'es'), f('2026-11-27T12:00:00Z', 'diaMes', 'es', 'UTC'), 'el mismo formato que el navegador');
});
