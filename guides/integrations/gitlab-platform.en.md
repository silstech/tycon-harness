# GitLab as the team platform

In Spanish: [gitlab-platform.md](gitlab-platform.md).

This guide is the GitLab case for what the harness steps say in neutral terms: «the work item», «the change request»,
«the CI» and «the team platform». It applies to public GitLab and to a self-hosted instance. The GitHub case is in
`guides/integrations/github-platform.en.md` and the Azure DevOps one in `guides/integrations/ado-projects.md`; how a
connector is built, in `guides/integrations/platform-connectors.en.md`.

The connector lives in `integrations/gitlab/`. It talks to GitLab through the machine's `glab`.

---

## What each thing is in GitLab

| In the harness steps | In GitLab |
|---|---|
| the story's work item | an issue in the stories project |
| its type (story, bug) | a `tipo:<Tipo>` label |
| its state | closed is the closed issue; otherwise, the `estado:<estado>` label, or «abierto» (open) |
| the hours worked | the issue's time spent (its native field) |
| the estimate | the issue's time estimate (its native field), in hours or in whole days |
| the change request | a merge request |
| merging on its own | «merge when the pipeline succeeds», or waiting for the commit statuses of the tip |
| the CI | the commit statuses of the tip, the newest of each context; a job GitLab allows to fail and a manual job never triggered do not count against it |
| what is assigned | the open issues and merge requests, one row per assignee |

What an issue does not have on every plan (the priority, a custom field, the parent epic) is not dropped silently: the
step gets it as «no soportado» (not supported) with its name. The same goes for an estimate in points.

## How a repo is declared

A GitLab product repo is declared in `team-repos.json`, in `merge_suites` or in `story_index`, with its platform, its
namespace and its name:

```json
{ "platform": "gitlab", "host": "gitlab.example.com", "namespace": "producto/plataforma", "repo": "servicio" }
```

- `namespace` is the group with all its subgroups, separated by `/`.
- `host` is the server of a self-hosted instance, without `https://` or a path. A repo on public GitLab does not carry
  it: the connector sets the server.
- A repo declared without `host` and the same repo with `host` are two different entries: always declare it the same
  way.
- A repo that is not declared (requested by its name, or as the work items project) goes to public GitLab only if
  `team-repos.json` declares no GitLab repo with `host`. If it declares one, that repo may live on the self-hosted
  instance, and the operation answers «sin plataforma» (no platform) and asks to declare it with its `host`, instead of
  sending issues or merge requests to the public server. A repo that carries its `host` in its identity goes to that
  server.
- The harness's own repos (`public`, `profile`, `operations`, `maintainers`, `harness_copies`) and the test tool repos
  (`stack.test_runners`) do not accept GitLab yet: the file rejects it and says where it does go.

The merge requests and the CI of that repo go through GitLab with nothing else needed. The rest (the work items, what is
assigned) is chosen by the team profile, `integrations.platform`: `"gitlab"` for everything, or per area
(`{ "default": "github", "workItems": "gitlab" }`). To see what was chosen:
`node scripts/lib/platform/platform.js chosen`.

On the command line, a repo is named by its full path or by its identity:
`node scripts/lib/platform/platform.js ci.read --repo producto/plataforma/servicio --args '{"branch":"main"}'`.

## What each machine needs

- `glab` installed and signed in to that server (`glab auth login --hostname <servidor>`). Without a session, each
  operation answers «falta la credencial» (the credential is missing) with that command; without `glab`, «no medido»
  (not measured); without network, «red» (network). None of them carries on as if there were nothing.
- `TYCON_GLAB_CMD` replaces `glab` (an executable, or a `.js` that runs with node): the tests use it.

## Where the work items go

The stories repo declares where its issues go in `.tycon/work-items.yaml`:

```yaml
repo: producto/plataforma/historias   # la ruta entera del proyecto de los issues
type: "Historia"                      # la etiqueta tipo:<Tipo> del pedido
state_active: "en curso"              # la etiqueta estado:<estado> al arrancar
default_tags: "tycon"
```

The server is the one of the GitLab repo with that path declared in `team-repos.json`. If the file is there and cannot
be read, the operation answers «no medido» (not measured): it sends nothing to the public server just in case.

## A clone's remote

GitLab has no single server, so a remote is recognized by what the organization declared: a clone's `origin` is GitLab
if its server is the one of some GitLab repo in `team-repos.json`, over SSH or HTTPS. A remote on a server nobody
declared is still «from another server»: there the harness does not open merge requests. An ssh alias is not resolved:
the remote has to name the declared server. If `team-repos.json` cannot be read, it is not known which server the remote
belongs to: with merging by merge request (`merge.mode: pr`), the plan stops instead of pushing directly.

## How a merge request gets in

1. The publishing brake reads the title and the description before they go out: if it stops them, nothing goes out.
2. If there is already an open merge request for the same pair of branches, its title and description are changed;
   otherwise, one is created. In both cases with the branch deletion that whoever opens it asked for.
3. If it conflicts with its target, the result says so (`conflict`) and the merge is not requested.
4. With a pipeline running on the tip, «merge when the pipeline succeeds» is requested.
5. Without a pipeline, the commit statuses of the tip are awaited and it is merged tied to that tip. A red status or a
   rejected merge is a «no» with the merge request number; statuses that do not finish in time are «no medido» (not
   measured), never «entró» (got in).

Always with a merge commit, never squashed.

When merging to the main branch with the merge skill, the `merge-pr.js` plan brings, for a declared GitLab repo,
`host: "platform"` and `repo` with its identity: that `repo`, in JSON, is what goes in the `--repo` of the merge request
step. The harness does not read which checks the branch requires in GitLab: with the `automatico` rule of
`merge_suites`, the full suites run on the machine before the merge request is opened.

## The rules the agent sees

`integrations/gitlab/rules.md` has what `glab` does not say on its own: that the server always goes on the command line,
that a merge request without a pipeline is merged on the spot, and that the commit statuses are read before concluding.
They do not go in every session's `CLAUDE.md`: they show up the first time the agent uses `glab mr`, `glab ci`,
`glab api` or `glab issue` in a session, and only if the organization chose GitLab for something
(`integrations/gitlab/notices.json`).

## What it does not handle yet

- The queue (`queue.read`), the deployments (`deployments.read`) and a branch's approval rule (`branch-rules.read`): the
  connector does not declare them and the layer answers them «no soportado» (not supported).
- Epics and merge trains, which belong to the paid plans.
- Voting on a merge request records only the approval; any other vote is «no soportado» (not supported).
- The nightly processes, onboarding an organization with its profile on GitLab, and the organization site do not use
  GitLab repos yet.

The operations it does handle are in `integrations/gitlab/integration.json`.
