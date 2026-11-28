'use strict';
// gitlab-http.js — la API v4 de GitLab por HTTP directo (el fetch de Node), para los procesos de la noche: en el servidor
// de la noche no hay glab. Lo usa repos.js (listar y clonar los repos de una fuente).
//
// Cuidados, porque el pedido lleva el token:
//   · sólo https, al servidor de la fuente (`host`, o gitlab.com); TYCON_GITLAB_PORT pone un puerto (una instalación
//     propia en un puerto que no es el 443, y los servidores de laboratorio de las pruebas);
//   · `redirect: 'manual'`: fetch saca `Authorization` al redirigir a otro servidor, pero no `PRIVATE-TOKEN`; una
//     redirección no se sigue y la fuente queda no medida con su motivo;
//   · un tope de tiempo por pedido y uno total (TYCON_GITLAB_DEADLINE_MS, por defecto 5 minutos): un tope alcanzado es
//     «no medido», nunca una lista más corta.
// Los motivos son los del contrato: 401 o 403 → rechazado; 404 → no_encontrado; la red → red; lo demás → no_medido.

const PUBLIC_HOST = 'gitlab.com';
const POR_PEDIDO_MS = 60000;
const TOTAL_MS = 5 * 60 * 1000;

/** El servidor de una fuente, con su puerto si lo hay: `https://<host>[:<puerto>]`. */
function serverOf(source, env) {
  const host = source && source.host ? String(source.host) : PUBLIC_HOST;
  const port = String((env && env.TYCON_GITLAB_PORT) || '').trim();
  if (port && !/^\d{1,5}$/.test(port)) throw new Error(`TYCON_GITLAB_PORT «${port}» no es un puerto`);
  return `https://${host}${port ? `:${port}` : ''}`;
}

/** El instante en que vence la lectura entera, desde ahora. */
function deadlineFrom(env) {
  const n = Number((env && env.TYCON_GITLAB_DEADLINE_MS) || TOTAL_MS);
  return Date.now() + (Number.isFinite(n) && n > 0 ? n : TOTAL_MS);
}

const no = (reason, detail) => ({ ok: false, reason, detail });

/**
 * Un GET a la API con el token: `{ ok: true, body, headers }` o un «no» del contrato. `donde` nombra lo que se pide en el
 * motivo (por ejemplo «la página 2 de los proyectos de acme»).
 */
async function getJson(url, token, { deadline, donde }) {
  const queda = deadline - Date.now();
  if (queda <= 0) return no('no_medido', `se alcanzó el tope de tiempo total antes de pedir ${donde}: no se mide a medias`);
  if (!url.startsWith('https://')) return no('no_medido', 'la dirección del servidor no es https: el token no se manda');
  let res;
  const porTope = queda < POR_PEDIDO_MS;
  try {
    res = await fetch(url, { headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(Math.min(POR_PEDIDO_MS, queda)) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return no('no_medido', porTope ? `se alcanzó el tope de tiempo total pidiendo ${donde}: no se mide a medias` : `${donde} no contestó a tiempo (tope de tiempo de un pedido)`);
    }
    const causa = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'sin detalle';
    return no('red', `no pude hablar con el servidor pidiendo ${donde} (${String(causa).split('\n')[0]})`);
  }
  if (res.status >= 300 && res.status < 400) return no('no_medido', `el servidor redirigió el pedido de ${donde} a otra dirección (${res.status}): no se sigue, para que el token no salga del servidor`);
  if (res.status === 401 || res.status === 403) return no('rechazado', `el servidor rechazó la credencial (${res.status}): renovalo (un token con read_api y read_repository)`);
  if (res.status === 404) return no('no_encontrado', `${donde}: no existe o el token no lo ve (404)`);
  if (!res.ok) return no('no_medido', `el servidor contestó ${res.status} en ${donde}: no se mide a medias`);
  let body;
  try { body = await res.json(); } catch (_) { return no('no_medido', `${donde}: la respuesta no es JSON`); }
  return { ok: true, body, headers: res.headers };
}

module.exports = { PUBLIC_HOST, serverOf, deadlineFrom, getJson };
