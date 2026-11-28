#!/usr/bin/env bash
# pipelines/operations/github/clone-repos.sh — los clones de los repos de la organización en GitHub.
#
#   clone-repos.sh --declared <destino>
#       Para la revisión de dependencias. Lee de la entrada las líneas `<ruta>\t<dueño>/<repo>` (lo que imprime
#       `nightly-dependencies.js clone-list`) y clona cada repo, rama main, en `<destino>/<ruta>`. El token de la
#       organización va SÓLO en la línea de comando del clon (decisión 14): ningún clon lo guarda en su config, porque
#       el paso siguiente corre código de los productos (`dotnet restore`).
#   clone-repos.sh --org <destino> [--team-repos <archivo>]
#       Para las métricas. Descubre los repos de cada dueño de `OWNERS` (separados por `;`; vacío: GITHUB_REPOSITORY_OWNER),
#       paginado, según la credencial (`ORG_TOKEN_KIND`; vacía, se averigua: sólo el token de una App lee
#       `installation/repositories`):
#         · `app` (el token de la GitHub App): los repos donde la App está instalada (`installation/repositories`), de los
#           dueños de OWNERS; privados incluidos, en una organización y en una cuenta de usuario. Un dueño sin ningún repo
#           ahí sale como aviso (la App no está instalada en sus repos);
#         · `user` (el usuario de máquina): de una organización, `orgs/<dueño>/repos?type=all`; de una cuenta de
#           usuario, `users/<dueño>/repos?type=owner` —que da SÓLO los públicos— más los de ese dueño que la credencial ve
#           por `user/repos?affiliation=owner,collaborator` (los privados del dueño o donde el usuario es colaborador).
#       Con `PREFIX`, sólo los que empiezan así; sin las copias
#       del arnés que declara team-repos.json (`harness_copies` de GitHub, salvo la de `maintainers` si está en la lista:
#       la regla es la del lector, scripts/lib/team-repos.js). Clona LIVIANO (`--filter=blob:none`, sólo
#       Markdown, `.advisors/` y `.tycon/`) en `<destino>/<dueño>__<repo>` (lo parten en `__` las métricas). El clon
#       liviano baja contenido después: el token queda en la config de esos clones, en un trabajo que sólo lee Markdown.
#
# Necesita ORG_TOKEN, por env del paso: el token de la GitHub App (recomendado) o el secreto HARNESS_ORG_TOKEN (un usuario
# de máquina). Habla con GitHub por TYCON_GH_CMD (por defecto gh; un `.js` corre con node) y clona desde GITHUB_SERVER_URL
# (las pruebas usan una carpeta local).
# Un repo que no se pudo listar o clonar se NOMBRA (un barrido que se achica en silencio se lee igual que uno completo), y
# cero repos vistos es un aviso, nunca un verde mudo (en una cuenta de
# usuario el camino de `users/` no trae los privados, y la corrida saldría verde con «repos vistos: 0»).
# Salida: 0 (lo que falló va como ::warning::) · 1 sin credencial, sin poder listar a un dueño, o error de uso.
#
# La lógica de listar y clonar vive en el conector de la plataforma de esta carpeta (integrations/<la carpeta>/scripts/
# repos.js): este guion valida, enmascara la cabecera en la salida del paso y le delega, con la misma interfaz y la misma
# salida.
# Con `nightly.sources` en operations.json (OPERATIONS_FILE; por defecto, el de la carpeta en que corre), `--org` no mira
# a los dueños: corre el paso común de la noche (scripts/nightly/sources.js), que le pide a cada fuente sus repos por la
# capa de plataforma y deja el índice de carpetas y el estado por fuente en DASHBOARD_DIR (por defecto, .dashboard). Una
# sección mal escrita se avisa y la noche sigue con lo de hoy.
set -uo pipefail

MODE="${1:-}"; DEST="${2:-}"; TEAM_REPOS=""
[ "${3:-}" = "--team-repos" ] && TEAM_REPOS="${4:-}"
case "${MODE}" in --declared|--org) ;; *) echo "uso: clone-repos.sh --declared <destino> | --org <destino> [--team-repos <archivo>]" >&2; exit 1 ;; esac
[ -n "${DEST}" ] || { echo "uso: falta el destino" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPS="${OPERATIONS_FILE:-operations.json}"
# los repos que declara la revisión de dependencias (en el árbol armado, la copia del repo de operaciones): la noche
# avisa de los que la fuente no devolvió
REPOS_JSON="${REPOS_JSON_FILE:-scripts/nightly/dependencies/repos.json}"
[ -f "${REPOS_JSON}" ] || REPOS_JSON=""
if [ "${MODE}" = "--org" ] && [ -f "${OPS}" ] && node "${HERE}/scripts/nightly/sources.js" declared --operations "${OPS}"; then
  exec node "${HERE}/scripts/nightly/sources.js" clone --dir "${DEST}" --operations "${OPS}" ${TEAM_REPOS:+--team-repos "${TEAM_REPOS}"} ${REPOS_JSON:+--repos-json "${REPOS_JSON}"} --dashboard "${DASHBOARD_DIR:-.dashboard}"
fi
[ -n "${ORG_TOKEN:-}" ] || { echo "::error::Falta la credencial de la organización para leer sus repos: la GitHub App (variable HARNESS_APP_CLIENT_ID y secreto HARNESS_APP_PRIVATE_KEY) o el secreto HARNESS_ORG_TOKEN. No se clonó nada"; exit 1; }
AUTH="$(printf 'x-access-token:%s' "${ORG_TOKEN}" | base64 | tr -d '\n')"
echo "::add-mask::${AUTH}"
CONECTOR="$(basename "$(dirname "${BASH_SOURCE[0]}")")"
REPOS_AUTH_HEADER="AUTHORIZATION: basic ${AUTH}" exec node "${HERE}/integrations/${CONECTOR}/scripts/repos.js" "${MODE#--}" "${DEST}" "${TEAM_REPOS}"
