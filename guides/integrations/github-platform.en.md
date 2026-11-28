# GitHub as the team platform

In Spanish: [github-platform.md](github-platform.md).

This guide is the GitHub case for what the harness steps say in neutral terms: «the work item», «the change
request», «the CI» and «the team platform». The Azure DevOps one is in `guides/integrations/ado-projects.md` and its
`ado-*` neighbors; how a connector is built, in `guides/integrations/platform-connectors.en.md`.

The connector lives in `integrations/github/`. It talks to GitHub through the machine's `gh`.

---

## What each thing is in GitHub

| In the harness steps | In GitHub |
|---|---|
| the story's work item | an issue in the stories repo |
| its type (story, bug) | a `tipo:<Tipo>` label |
| its state | closed is the closed issue; otherwise, the `estado:<estado>` label, or «abierto» (open) |
| the hours worked | a fixed-format comment, «Horas completadas: N h» (Hours completed: N h) (an issue has no such field) |
| the estimate | the numeric field of a GitHub project, or a comment «Estimación: 16 h (historia, versión 2)» (Estimate: 16 h (story, version 2)) |
| the change request | a pull request |
| that it merges on its own | auto-merge, or the merge queue if the branch has one |
| the CI | the checks on the tip: the check-runs and the commit statuses, the newest of each |
| the queue | the Actions runs waiting or in progress in the team's repos |

What an issue does not have (the priority, a custom field, the parent Epic) is not dropped silently: the step gets it
as «no soportado» (not supported) with its name.

## How it is chosen

- **The repos:** each GitHub repo is declared in `team-repos.json` with its platform. The change requests and the CI
  of that repo go through GitHub with nothing else.
- **The rest** (the work items, the queue, the deployments) is chosen by the team profile, `integrations.platform`:
  `"github"` for everything, or per area (`{ "default": "github", "workItems": "github" }`).
- To see what was chosen: `node scripts/lib/platform/platform.js chosen`.

## What each machine needs

- `gh` installed and signed in (`gh auth login`), or the `GH_TOKEN` variable. Without that, each operation answers
  «falta la credencial» (the credential is missing) with the command to load it; it never goes on as if nothing were
  wrong.
- The read permission for the team repo is a different one: `github.token`, which each person loads with
  `harness.js config set github.token`. It never goes into the profile or a versioned file.
- `TYCON_GH_CMD` replaces `gh` (an executable, or a `.js` that runs with node): the tests use it.

## Where the work items go

The stories repo declares where its issues go in `.tycon/work-items.yaml`:

```yaml
repo: acme/historias          # dueño/nombre del repo de los issues
type: "Historia"              # la etiqueta tipo:<Tipo> del pedido
state_active: "en curso"      # la etiqueta estado:<estado> al arrancar
default_tags: "tycon"
github:
  project: { owner: acme, number: 3, field: "Estimación" }   # opcional: el campo numérico que recibe la estimación
```

Without `github.project`, or if the project cannot be used (no permission, the project or the field does not exist),
the estimate goes as a comment and the result says why.

## How a change request gets in

1. The publishing brake reads the pull request before it goes out: if it stops it, nothing goes out.
2. If there is already one open for the same pair of branches, its title and body are changed; if not, one is
   created.
3. If the repo allows auto-merge, it is requested and the pull request is read again.
4. If it did not get set, the harness waits for the checks on the tip and merges with a merge commit tied to that tip.
   A red check, a conflict or a rejected merge is a «no» with the pull request number; checks that do not finish in
   time are «no medido» (not measured), never «entró» (merged).

The harness does not delete the branch: the repo's rule decides it («delete the branch on merge»).

## The rules the agent sees

`integrations/github/rules.md` has what `gh` does not say by itself: that the merge queue hides auto-merge, that
`gh pr checks` comes before concluding, and the noreply identity in test copies. They do not go in the `CLAUDE.md` of
every session: they show up the first time the agent uses `gh pr`, `gh run`, `gh api` or `gh issue` in a session, and
only if the organization chose GitHub for something (`integrations/github/notices.json`).

## What it does not handle yet

Voting on a change request (`change-request.vote`) is not there: the connector answers «no soportado» (not
supported). The operations it does handle are in `integrations/github/integration.json`.
