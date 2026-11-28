# Platform connectors — how to add a platform to the harness

In Spanish: [platform-connectors.md](platform-connectors.md).

The harness core does not talk to Azure DevOps, GitHub or GitLab: it talks to **the team's platform**, through a layer
(`scripts/lib/platform/platform.js`) that picks which connector handles each operation and passes it the request. This
guide is for whoever wants to add another platform: what the connector has to handle, what it has to answer and how to
test that it complies.

The three connectors the harness ships serve as live examples: `integrations/azure-devops/`, `integrations/github/` and
`integrations/gitlab/`. Each one's case, for whoever uses it, is in `guides/integrations/ado-projects.md`, in
`guides/integrations/github-platform.en.md` and in `guides/integrations/gitlab-platform.en.md`.

---

## What a connector is

A folder in `integrations/<name>/` with:

| File | What for |
|---|---|
| `integration.json` | the manifest: which operations it handles, what it can do, which raw commands of its platform the guards recognize |
| `scripts/connector.js` | the code: it exports `run(operación, args, ctx)` and answers within the contract |
| `rules.md` (optional) | the platform rules the agent has to know when it uses it |
| `notices.json` (optional) | when those rules are shown: the first time the agent uses the platform's CLI in a session |

The core never calls a connector or its CLI directly: the scripts, the hooks and the agent's steps call the layer, and
the layer calls the connector the organization chose.

## Who chooses the connector

- What is tied to a repo (the change requests and the CI) goes through the platform that repo declares in
  `team-repos.json`.
- The rest is chosen by the team profile, `integrations.platform`: per area (`workItems`, `queue`) or its `default`.
- With no choice, with a value that is not an installed connector, or with a connector that is missing, the layer
  answers `sin_plataforma` with the reason and how to choose one. It never picks a platform out of habit or from the git
  remote.

To see what the organization chose: `node scripts/lib/platform/platform.js chosen`. To see which connector would handle
an operation without asking it anything: `node scripts/lib/platform/platform.js choose <operación> [--repo <org/repo>]`.

---

## The manifest (`integration.json`)

```json
{
  "name": "acme-forge",
  "label": "Acme Forge",
  "kind": "platform",
  "connector": "scripts/connector.js",
  "operations": ["work-item.create", "work-item.read", "change-request.open", "ci.read"],
  "capabilities": { "completedHours": "comment", "estimate": "comment", "workItemType": "label", "autoComplete": "auto-or-wait" },
  "rawCommands": ["forge pr create", "forge issue close"],
  "changeRequestCommands": ["forge pr create"],
  "draftOptions": [{ "command": "forge pr create", "options": [{ "name": "--draft", "separateValue": false }, { "name": "-d", "separateValue": false }], "abbreviations": false }],
  "readyCommands": [{ "command": "forge pr ready", "unless": [{ "name": "--undo", "separateValue": false }], "abbreviations": false }],
  "settings": [{ "key": "acme-forge.token", "type": "secreto", "env": "TYCON_ACME_FORGE_TOKEN" }]
}
```

- `kind: "platform"` is what makes it a platform connector; the integrations reader (`scripts/lib/integrations.js`)
  validates the manifest and stops a broken one with its reason.
- `operations` lists the ones it handles. **The ones it does not list, the layer answers `no_soportado` without calling
  it**: you can start with a few.
- `capabilities` says how it handles what its platform does not have the same way as the others, so that the step that
  uses it knows what to expect:

  | Key | Values | What it says |
  |---|---|---|
  | `completedHours` | `field` · `comment` | the hours worked go to a field of the work item or to a comment with a fixed format |
  | `estimate` | `field` · `comment` · `project-or-comment` | where the story's current estimate is kept |
  | `workItemType` | `native` · `label` | the work item's type (story, bug) is native or goes as a label |
  | `autoComplete` | `native` · `auto` · `auto-or-wait` | the change request goes in by itself, or the connector waits for the checks and merges it |

- `rawCommands` are the platform's raw commands that are not run by hand because there is an operation that replaces
  them (create a pull request, close one). The guards read them from here (`platform.js raw-command '<comando>'`): a new
  connector does not touch any guard, it declares its commands.
- `changeRequestCommands` are the ones in `rawCommands` that create or merge a change request, with their aliases. The
  save guard sends them through the person's window inside a run, like a `git push` to a shared branch. Each one has to
  be in `rawCommands`: if not, the reader stops the manifest.
- `draftOptions` and `readyCommands` (optional) tell the save guard what a draft looks like on the platform. A draft
  cannot be merged: before «Preparar el pull request» (the «Prepare the pull request» step), opening one asks in the
  window instead of stopping, and marking it ready is a request that needs the step closed (this is described in
  `guides/owner-signatures.en.md`, under the save guard). A connector without these fields is valid: its draft is not
  recognized and is stopped before «Preparar» like any pull request.
  - `draftOptions`: for each command that creates a pull request (one of `changeRequestCommands`), the options that make
    it a draft (`options`) and whether the program accepts a shortened long option (`abbreviations`: in Azure DevOps,
    `--dr` is `--draft`).
  - `readyCommands`: the commands that mark a draft ready. Each one carries the option that has to appear as false to
    mark it (`"when"`: Azure DevOps's `pr update` with `--draft false`) or the one that rules it out (`"unless"`:
    `gh pr ready --undo` turns it back into a draft). With neither, the command always marks it. They do not go in
    `rawCommands`: they are not commands the layer replaces.
  - Each option is `{ "name", "separateValue" }`: the short name (`-d`) or long name (`--draft`), and whether the
    program reads its value separately (`--draft false`, in Azure DevOps) or only attached (`--draft=false`, in GitHub,
    where `gh pr ready --undo 12` is the option alone and the pull request number).
  - An option in `when` can declare its values (`"values"`): then it counts only with one of them, or with one that
    cannot be seen. This is how an `update` that completes the pull request, which means merging it, is declared: in
    Azure DevOps, `{ "name": "--status", "separateValue": true, "values": ["completed"] }`. Abandoning or reactivating
    it does not count.
  - `argumentFiles`, in both fields: the character that starts a word the program replaces with the contents of a file
    before reading its options (`"@"` in Azure DevOps: `az … @o.txt`). That word can carry any option, including the one
    that publishes the pull request.

  The reading is strict. On create, it is a draft only by the last occurrence written alone or with a «yes» (`true`,
  `yes`, `1`), that cannot be the value of the option before it, and in a command with no words that cannot be seen in
  full: a variable, a substitution or an argument file can carry `--draft=false`. On mark ready, any occurrence that
  could be one counts, and so does any word that cannot be seen in full: a «no», a variable, a value that cannot be
  understood, an argument file. GitLab does not declare these fields: a draft there becomes ready by removing «Draft:»
  from the title or with the `/ready` quick action in a comment, and the guard sees neither. Marking ready through the
  API (`gh api … markPullRequestReadyForReview`) is not seen either. `scripts/lib/integrations.js` rejects a badly
  written field.
- `settings` declares its configuration keys; the ones with `type: "secreto"` are never written in the team profile:
  each person loads them on their machine.
- `repoShape` is the shape of a platform repo in `team-repos.json`. It has four things:
  - `keys`: its keys in order; the last one is `repo`.
  - `name`: the expression, from `^` to `$`, of which name is valid.
  - `flags`: `"u"` if the name accepts letters from any language.
  - `nameHint`: the same thing said in words, for the error message.

  And two more, if needed:
  - `optional`: the keys a repo may not carry, such as the server of a self-hosted install. They go first in the repo's
    identity: the same repo with and without a server are two repos.
  - `rules`: a key's own rule, when it is not the name's. With `name`, `flags` and `nameHint`, another expression. With
    `parts` (the separator character, for example `"/"`), `partsHint` and `nameHint`, the value comes in segments: each
    segment is validated with the shape's name and there cannot be empty segments.

  The `team-repos.json` reader (`scripts/lib/team-repos.js`) asks every platform it admits for it: the core does not
  write any platform's shape, and without it the repos of that platform cannot be validated.

## The code (`scripts/connector.js`)

```js
'use strict';
const OPERACIONES = { 'work-item.read': leerPedido, 'ci.read': leerCI /* … */ };

function run(operacion, args, ctx) {
  const f = OPERACIONES[operacion];
  return f ? f(args, ctx) : { ok: false, reason: 'no_soportado', detail: `Acme Forge no atiende ${operacion} todavía` };
}

module.exports = { run };
```

`run` can return the result or a promise. What it receives in `ctx`:

| Field | What it is |
|---|---|
| `env` | the environment variables the layer was called with |
| `root` | the harness root: to reuse its readers (not the connector's folder, which can be a different one) |
| `repo` | the repo's identity (`{ org, repo, … }`, or `{ namespace, repo, host? }` where the repo lives in groups) in the operations tied to a repo |
| `label` | the platform's name for the messages |
| `secretState(clave)` | whether a secret is there (`{ present, estado }`), never its value |
| `readSecret(clave)` | the value, only when it is going to use it |
| `configValue('sección.clave')` | a value from the machine's configuration, or `undefined` |
| `configProblem(sección)` | whether that section's configuration could not be read: «could not be read» is not «the value is missing» |

### A clone's remote (optional)

A platform with a single server needs nothing more. One that each organization installs on its own server also exports
`identityFromRemote(url, declarados)`: it receives the address of a clone's `origin` remote and the repos of its
platform that `team-repos.json` declares, and returns the repo's identity as declared, or `null` if the server at that
address is not the server of any of them. The layer validates what it returns like a repo from the file. With that,
`scripts/tools/merge-pr.js` and `scripts/tools/story-index.js` recognize the clone without the core knowing the server;
a remote from a server nobody declared is still «from another server». The example is
`integrations/gitlab/scripts/remote.js`.

### What it answers

Always one of two shapes:

- `{ ok: true, value }`: it did what was asked, and `value` carries what is described below;
- `{ ok: false, reason, detail }`: it did not do it; `reason` is one of the closed reasons and `detail` says why, in one
  line that can be shown (without secrets: the layer also cleans out anything that looks like a token).

An exception, an answer with another shape or a made-up reason, the layer turns into `no_medido`: the error is not
lost, but the connector fell outside the contract and the conformance test flags it.

### The reasons for a «no»

| Reason | When |
|---|---|
| `sin_plataforma` | there is no platform chosen for that operation (the layer answers it) |
| `sin_credencial` | the token or the CLI session is missing; the `detail` says the command to load it |
| `no_soportado` | the platform does not have that, or the connector does not handle it yet |
| `no_encontrado` | what was requested does not exist (an item asked for by a number that does not exist) |
| `rechazado` | the platform or the harness denied it: a request without shape, a guard, a permission |
| `red` | the platform could not be reached |
| `no_medido` | a read that did not complete |

**A read that failed is `no_medido`, never an empty list or a zero.** This is the rule that matters most: a check that
reads «there are no open pull requests» or «the queue is free» from a cut-off read decides wrong. A list is returned
whole or not returned.

---

## The operations

They are in `OPERATIONS` in `scripts/lib/platform/contract.js`. Arguments that do not apply to a platform are ignored;
what the platform cannot load comes back in `unsupported` with its name, it is never silently dropped. Each `value` can
carry `warnings`: what came out halfway without being a «no» (a comment that was not posted after creating the work
item).

### The work item (the story on the platform)

| Operation | Receives | Returns in `value` |
|---|---|---|
| `work-item.create` | `type`, `title`, `description`, `acceptance`, `tags`, `epic`, `priority`, `fields`, `assignTo`, `estimate` | `id` of the created work item, `unsupported`, `warnings` |
| `work-item.update` | `id` and what changes (`state`, `title`, `fields`, `comment`, `estimate`, `assignTo`); `reopen` to reopen | `id`, `estado`, `previo`, `changed`; `pideReabrir: true` if it is closed and reopening was not requested |
| `work-item.close` | `id`, `hours` (or `seconds`), `comment`, `fields` | `id`, `hours`, `hoursAs` (`field` or `comment`), `unsupported` |
| `work-item.find` | `tag`: the exact label | `tag`, `ids` (open and closed, from all pages) |
| `work-item.read` | `id` | `id`, `estado`, `cerrado` (true or false) |

`estimate` has its own shape (`{ value, unit, hours?, level?, version? }`, with `unit` in `hours`, `days` or `points`);
the layer validates it before calling the connector and one without shape is `rechazado`. Where it is kept is decided
by the connector, which declares it in `capabilities.estimate`.

### The change request (the pull request)

| Operation | Receives | Returns in `value` |
|---|---|---|
| `change-request.open` | `sourceBranch`, `targetBranch`, `text` (its first line is the title if `title` does not come), `deleteSourceBranch`, and optional `title`, `check`, `waitMinutes`, `pollSeconds`, `repoDir` | the pull request number, how it goes in (`modo`) and whether it already went in (`merged`); `conflict: true` if it conflicts with its target |
| `change-request.vote` | the number and the vote | what the platform recorded |
| `change-request.list` | optional `sourceBranch` (the ones from that branch, each one read in full), `queue: true` (with its place in the queue), `checks: false` | the list of open ones: number, author, branch, whether it is in the queue (`inQueue`), whether its CI is running (`ciRunning`: `null` if it was not known) |
| `change-request.read` | `number` | `number`, `state` (`open`, `merged` or `closed`), `draft`, `autoComplete`, `inQueue`, `mergedAt`, `mergeCommit`, `title`; one that does not exist is `no_encontrado` |

`change-request.open` has its own shape (the contract's `openProblem`): branches without disguised options or `..`, a
text that does not start with `-` or `@`. The layer validates it before calling the connector. If the platform has no
automatic merge, the connector waits for the checks on the tip (only `check`, if it comes) up to `waitMinutes` and
merges it; checks that do not finish in time are `no_medido`, never «it went in».

### The assigned items, the CI, the queue and the deployments

| Operation | Receives | Returns in `value` |
|---|---|---|
| `assigned.list` | nothing | one row per assigned person: `tipo`, `id`, `titulo`, `estado`, `asignado`, `enlace` |
| `ci.read` | `branch` or `commit` | `state` (`succeeded`, `failed`, `running` or `none`) and `stages`: each check with its conclusion |
| `queue.read` | optional `repos` (if not, the team's in `team-repos.json`) | the list of runs waiting or in progress, with who triggered each one and since when |
| `deployments.read` | `entrada` (the pipeline or repo, its stages, the environment) and `entorno` | the deployments of that environment |
| `branch-rules.read` | optional `branch` (if not, the repo's main branch) | `branch` and `approval`: that branch's minimum approval rule (`enabled`, `blocking`, `minimum`, `creatorVoteCounts`, `resetOnSourcePush`), or `null` if it has none; with several, the one that is missing the least |
| `security-alerts.list` | nothing | the open security analysis alerts on the repo's main branch: `number`, `rule`, `severity`, `path`, `line`, `createdAt`; a repo without analysis is `no_soportado`. The stuck pull requests notice reads it: the check before queuing looks at the pull request's refs, and an alert that only shows up in main is not seen there |

What an approval rule is missing is decided by the contract (`approvalFaults`): a valid one is on, blocks, asks for at
least one approval, counts the vote of whoever opened the pull request and resets the approvals with each new push. It
is used by `scripts/tools/branch-approval.js`, which rereads the rule at the end of a product's setup and which
`harness.js doctor --fetch` runs over the repos the organization declares. A read that could not be done is
`no_medido`, never «no rule».

What a check concludes from `ci.read` and from `queue.read` is decided by the contract (`verdictOf`): green **only** with
a run that finished well. A «no» for any reason, `no_soportado` included, is `no_medido`. A green check is not a
deployment: that is what `deployments.read` says.

---

## The conformance test

```bash
node -e "require('./scripts/lib/platform/platform.js').conformance('acme-forge').then((r) => console.log(r))"
```

`conformance(nombre)` calls each operation the manifest declares with a test request and checks that each answer has
the contract's shape: `{ ok: true, value }` or `{ ok: false, reason, detail }` with a reason from the list. It returns
`{ problems: [] }` if it complies, or each operation with its problem. It needs no credentials: without them, the right
answer is `sin_credencial` with the command to load them, and that also complies.

**The example is the tests' fake connector**, `scripts/tests/lib/fake-platform/`: it declares all operations except
vote, asks for a secret token (without it, it answers `sin_credencial`, like a real one) and answers whatever the tests
tell it. `scripts/tests/platform-contract.test.js` uses it to test the whole layer (`FakePlatform_PassesConformance`)
and runs the same conformance on the Azure DevOps and GitHub connectors (`Conformance_AzureAndGithub_DeclaredOps`); the
GitLab one's is with its cases, in `scripts/tests/platform-gitlab.test.js`. For a new connector:

1. copy `fake-platform/` to `integrations/<name>/` and change the manifest;
2. replace each fake answer with the call to the platform, operation by operation;
3. add its name to the real connectors' conformance test and run it:
   `node --test scripts/tests/platform-contract.test.js`.

To test against the layer without installing the connector in the tree, `TYCON_INTEGRATIONS_DIR` points to another
integrations folder.

## The platform rules (`rules.md` and `notices.json`)

What the agent has to know about a platform (that a stale listing does not prove something did not happen, how a pull
request goes into the main branch) does not go into the `CLAUDE.md` of every session: it travels with its connector and
shows up the first time the agent uses that platform's CLI in the session.

```json
{ "notices": [ { "id": "reglas-de-la-plataforma", "text": "rules.md", "when": "after-command", "commands": ["forge pr", "forge run"] } ] }
```

- `when: "after-command"` shows it after the first command that starts with any of `commands` (the CLI and one of its
  first words), once per session; it shows up again if the conversation is compacted or cleared.
- It only shows up if the organization chose that platform for something (`platform.js chosen`): the rule of a platform
  the team does not use is never shown.
- `text` is the file, inside the connector's folder. The rules are written like the ones in `CLAUDE.md`: what to do,
  what not to do, and why in one line.
