# Mary+GOLD Format Guide for Stories

In Spanish: [story-format.md](story-format.md).

This guide defines how to write stories so that an LLM agent can implement them without ambiguity and without making anything up: what is not known gets asked before the story is written, and stays in its intent.

Use it as a reference when you write or validate stories in any project that follows this format.

The format is called **Mary+GOLD** because it combines:
- **Mary**: the analyst agent that writes stories anchored to real code
- **GOLD**: the quality checklist that checks the story can be implemented without errors

---

## The intent

Before the story comes its **intent**: what we want to solve and why, without the how. It is a separate file, next to
the story and with the same name (`<historia>.md` → `<historia>.intent.md`), in the open format
IntentSpec 1.2 (https://intentspec.org/spec). The short path also has an intent, a short one, in the run folder
(`intent.md`). The template is `skills/tycon-create-story/intent-template.md`.

**What it holds.** The IntentSpec frontmatter: `id` (the file name without `.intent.md`), `status`, `objective` (the
problem and why it matters) and `outcomes` (what you see when it is solved, at least one). It may have the sections
IntentSpec recognizes (`## Constraints`, `## Edge Cases`, `## Verification`). And two sections of its own, which IntentSpec
does not read and so do not make it invalid:

- `## Preguntas abiertas` (open questions) — what is not known. Columns: `#` (`Q1`, `Q2`…), `Pregunta`, `Por qué importa`,
  `Quién contesta`, `Bloquea`, `Estado`, `Respuesta`, `Fuente`.
- `## Decisiones reservadas` (reserved decisions) — what a person decides: the agent proposes, it does not decide. Columns: `#` (`R1`, `R2`…),
  `Decisión`, `Por qué es de una persona`, `Quién decide`, `Propuesta del agente`, `Estado`, `Respuesta`, `Fuente`.

With no rows, the section says `Ninguna.` alone (in the reserved one, also `Ninguna, porque <motivo>.`). The values are
closed and are not normalized (`Si` is not `sí`):

| Column | Values |
|---|---|
| Bloquea | `sí`, `no` |
| State of a question | `abierta`, `supuesta`, `encontrada`, `contestada`, `descartada` |
| Source of a question | `persona:<nombre>`, `repo:<archivo:línea>`, `memoria:<id>`, `pedido:<número>`, `—` |
| State of a decision | `abierta`, `tomada`, `descartada` |
| Source of a decision | `persona:<nombre>`, `—` |

A `supuesta` (assumed) question does not block (work goes on with the assumption, marked); an `encontrada` (found) one has source `repo:` or
`memoria:`; a `contestada` (answered) or `descartada` (dropped) one, `persona:`; `pedido:` only informs, in an `abierta` (open) or a `supuesta` one.
What blocks: a question with `Bloquea: sí` until it is `encontrada` in the repo (`repo:` pointing to a file and a line
that exist) or a person answered it; a reserved decision, always, until a person takes it. Something written can
answer a question, but can never take a decision that belongs to a person.

**How to mark what is missing.** In the text, `[falta: Q<n>]` or `[falta: R<n>]`, with its row in the table. A mark
for a row that does not exist is a problem; one for a row already closed is a warning (the mark is stale).

**When it is approved and frozen.** It is approved (`status: approved`) when nothing blocking is left, before
the story moves to `ready-for-dev`. From then on it is **frozen**: it is the snapshot of what was known at the start. What
is learned later goes into the story.

**Why it is not a second source of truth.** The intent is not maintained: it is not synced with the story and it is not
corrected. Today's truth is the story; the intent keeps what was asked, what was assumed and who decided what. Ideas
from before the interview can keep living in memory; the intent is born with the interview.

The check: the pre-commit validates each intent against the IntentSpec schema and these rules
(`scripts/lib/lint-story-frontmatter.js`, with its reader `skills/tycon-pipeline/scripts/lib/intent.js`), and stops an
approved intent that still has something blocking.

---

## File structure

Every story is a Markdown file with this exact structure, in this order:

### 1. YAML frontmatter

```yaml
---
epic: 2
story: "2.3"
title: "POST /pedidos -- crear pedido, reservar stock, devolver el remito"
status: done          # vocabulario completo en scripts/metrics/states.json (ver abajo)
sprint: 1
priority: "P0"        # P0 = blocker, P1 = must, P2 = should, P3 = nice
approach: "[ADAPT]"   # [EXTRACT] = copiar de fuente | [ADAPT] = adaptar | [CREATE] = nuevo
depends_on: ["2.1", "2.2", "1.3"]
work_item: 12345  # auto-poblado al crear la story (ver nota abajo); id del pedido de trabajo
---
```

- `status` — **there is ONE vocabulary and it lives in `scripts/metrics/states.json`**.
  The canonical ones, in flow order: `draft` · `backlog` · `ready-for-dev` ·
  `in-progress` · `review` · `blocked` · `done`, plus the four terminal ones **that are not a
  delivery**: `cancelled`, `abandoned`, `superseded` and `reverted`. That file also holds the
  aliases for what the repos already use (`pending` → `backlog`, `implementation-complete` →
  `review`, `merged` → `done`, …) and the written reason for each non-obvious decision.
  - **`draft` is a story the validator has not reviewed yet.** A new story is born in `draft`; the harness does not
    let you write a new story in another state, or move a draft to `ready-for-dev`, unless the story
    validator (`tycon-story-validator`) has run on that file after its last write. The
    `tycon-create-story` skill does it in its step 6 (or the agent after `story-without-bmad.js write`); skipping it is authorized by the
    person with «autorizo story-skill-bypass» ("I authorize story-skill-bypass"). The pipeline does not start on a draft, and if the session leaves one
    unvalidated, the end of the turn tells the agent to validate it and, if it does not move forward, tells the person.
  - 🔴 **The list is CLOSED on purpose, and what is not in it is NOT discarded**: it comes out as
    `desconocido:<valor>`, it is counted apart and it shows up by name on the dashboard. Writing a
    state that is not in the dictionary breaks nothing and gives no error — it only makes the story
    show up in the card «con un estado que el diccionario no reconoce» (with a state the dictionary does not recognize), which is the work list
    for the next dictionary. Adding an alias is a decision taken **by looking at that
    counter**, not before.
  - 🔴 **`pipelines[].status` (§1.1) is ANOTHER vocabulary**: it describes the state of a **delivery
    batch**, not of the story. They have the same name and measure different things — the state
    dictionary does not absorb it, and the other way around neither.
  - `blocked` and `abandoned` are written by the pipeline orchestrator itself (`marker.js`), so
    they are official vocabulary even though nobody types them by hand.
- `approach` says how much existing code is reused vs created new:
  - `[EXTRACT]` = copy a pattern from an identified source
  - `[ADAPT]` = adapt a pattern **already solved** somewhere else (sibling project, existing feature)
  - `[CREATE]` = new code, with no source pattern
  - 🔴 **`approach` is self-declared — it is NOT what triggers the "Verified reference pattern" section**. That section (§9.2) is **mandatory in every backend story**, whatever its `approach`. A `[CREATE]` label does not exempt you from looking for the sibling pattern: a story labeled `[ADAPT]` can still invent the fix opposite to the real pattern. See §9.2 + GOLD rule #9.
- `story` — 🔴 **a story's id must be unique within its repo**.
  The harness names the closing evidence, the QA guides and the run folders with it, and a
  person or an agent uses it to say «story `<N.M>`». Today the team numbers in two ways:
  - **Epic number first** (`epic: 2` → `story: "2.3"`), with all the stories in one
    folder: the id is unique by construction. **It is the recommended one for a new repo**: it does
    not depend on where the file lives and nobody needs to be told which of several «1.1» is
    meant.
  - **Folder per topic** (`.specs/<tema>/stories/`, `docs/<área>/epic-*/`), where each topic
    starts again at 1.1: the number repeats across topics.
  If the number repeats, the closing evidence is kept apart on its own: the key becomes
  `<tema>__<número>` (`skills/tycon-pipeline/scripts/lib/evidence-key.js`; by hand:
  `pipeline.js evidence-key --story <ruta>`). But «story `<N.M>`» is still ambiguous for whoever
  looks for it, and so the frontmatter lint **warns** about each repeated number with its paths (it does not
  stop: when this was written there were 23 in one repo and 8 in another).
- `depends_on` lists stories that must be implemented first
- `work_item` — id of the story's work item on the team's platform (an Azure DevOps work item, a GitHub issue). The old name, `ado_work_item`, is still read (with both, `work_item` wins) and nobody writes it; the frontmatter lint warns if a new story is born with it. **It is filled in automatically when the story is created**: the `on-story-create.js` hook of the ADO integration (`integrations/azure-devops/scripts/`) detects the new story without this field and calls the `tycon-story-work-item` skill, which creates the work item in ADO (with the dev's confirmation) and writes the id here. Later it is used by `tycon-pipeline` step-00c (moves the WI to `Active` when implementing) and step-09 (posts a traceability comment with commit SHAs + CI run + PR link and moves it to `Closed` when closing). If the repo has nowhere to create the work item (no `.tycon/work-items.yaml`, nor the old-name Azure DevOps file, nor the organization on the machine), the field simply does not appear — the skill skips silently. Full detail of the flow and of the config schema: `guides/integrations/ado-projects.md`.

#### 1.0 🔴 The frontmatter must be READABLE — a malformed story is an invisible story

All the harness tools (validator, back-link backfill, status scripts, DoD hook) cut the frontmatter with `content.indexOf('\n---', 3)` and read the scalars with `/^campo:\s*"?([^"\n]+?)"?\s*$/m`. **When that parsing fails, the story gives no error: it is skipped silently.** It stops existing for the harness without anybody noticing.

Two ways to break it, both seen in production:

| How it breaks | What happens |
|---|---|
| **The closing `---`** of the frontmatter **is missing** | `indexOf` returns -1, or it catches a horizontal rule `---` in the body and swallows half the file as if it were frontmatter |
| **Double quotes inside an inline comment** (typical in `status:`) | The scalar's `[^"]` cuts at the first quote, the `$` does not match, the field gives `null`. The collector requires non-null `story`+`epic`+`status` → it discards the story |

```yaml
status: done  # ver "Preguntas abiertas"      # ❌ rompe el parseo del harness
status: done  # ver 'Preguntas abiertas'      # ✅ comillas simples en el comentario
```

**Why it matters (measured in one repo):** 4 stories without the closing `---` + 2 with quotes in the `status` comment were **invisible for ~2 months**: the backfill saw 276 stories where there were 281. One of them, on top of that, hid a DoD evidence debt that the pre-commit hook could not detect precisely because it could not read the file.

**Enforcement**: `scripts/lib/lint-story-frontmatter.js` (0 deps) replicates the harness's real parser and fails if a story is not readable. **It is not copied into each repo**: it lives only in this repo and the projects point to it by path from their `.githooks/pre-commit` (exact snippet in the script's header). This works because onboarding clones the harness at a fixed path and `SessionStart` runs `git pull` on it at every start, and because a pre-commit always runs locally, never in CI. It runs only on the stories the commit touches.

> ⚠️ **The obvious check is not enough.** Looking for a `---` line with `grep`/`awk` gives false greens: any horizontal rule in the body satisfies it. Measured: that method found 2 of 4 broken files; the other 2 only showed up when actually parsing the frontmatter. That is why the lint replicates the parser instead of approximating it.

#### 1.1 Frontmatter — `pipelines:` block (optional, for stories delivered in batches)

When a story is big and is delivered in several batches (backend / frontend / sub-features), add a `pipelines:` block to the frontmatter so the `tycon-deferral-tracker` advisor can check that **nothing is left hanging without documenting why**.

It is **optional** — if the story is delivered in one go, it is not needed. If something is deferred, **it is mandatory** to declare the deferred batch with its `blocked_by` and the ACs/tasks/tests it covers.

**When NOT to split: if two batches touch the same files and neither is useful alone (it cannot be used or delivered separately), they go in a single batch.** Each batch adds its own plan, its reviewers, its tests and its signatures: a story split into two batches over the same screen cost two plans, two saves and two rounds of reviewers, and nobody could use the first without the second. Split when each batch is useful alone, or when something outside separates them (`blocked_by`). If two batches share files and each one is useful alone, each one says so in `delivers`: what someone can use or deliver with only that batch in. Without it, `tycon-story-validator` warns (**VAL-W19**).

```yaml
---
epic: 2
story: "2.2"
title: "Generación y Confirmación del Listado de Armado"
status: in-progress
sprint: 2
priority: "P0"
approach: "[CREATE]"
depends_on: ["1.1", "1.5", "1.6", "2.1"]
pipelines:
  - name: A-backend
    status: done                      # done | in-progress | blocked | pending
    acs: [1, 2, 3, 4, 5, 6]
    tasks: [1, 2, 3, 4]
    tasks_partial:
      - id: 5
        done: [5.1, 5.2, 5.3, 5.4]
        pending: [5.5]                # subtask diferida — debe estar en algún pipeline pending/blocked
  - name: B-frontend-recepcion
    status: in-progress
    acs: [1, 2, 3, 4, 5, 6, 11]
    tasks: [6, 7, 8, 9]
  - name: C-frontend-listado
    status: blocked
    blocked_by: "Story <N.M> Task 5.5 backend — endpoint GET /api/ceibo/pedidos/{id}/listado no mergeado"
    acs_pending: [7, 9, 10]
    tasks_pending: [10, 12, 13]
    tests_pending: ["T36", "T39", "T40"]
---
```

**Block schema** (validated by `tycon-story-validator` rule VAL-C6):

| Field | Type | When it is mandatory |
|-------|------|----------------------|
| `name` | string | always. Identifies the batch. Convention: `{letra}-{ambito}-{subtema}` (e.g. `A-backend`, `B-frontend-recepcion`, `C-frontend-listado`). |
| `status` | enum `done\|in-progress\|blocked\|pending` | always. 🔴 It is the state of the **batch**, not of the story: **another vocabulary**, which the dictionary in `scripts/metrics/states.json` does not absorb. |
| `acs` | int[] | when `status: done` or `status: in-progress` (ACs actually covered in that batch). |
| `tasks` | int[] | when `status: done` or `status: in-progress` (tasks covered). |
| `tasks_partial` | list of `{id, done, pending}` | if a task was partly covered — declare done vs pending subtasks. |
| `delivers` | non-empty string | when the batch shares files with another one that is not `done` yet: what someone can use or deliver with only this batch in (VAL-W19 if missing). |
| `blocked_by` | non-empty string | **mandatory when `status: blocked`** (rule VAL-C6 CRITICAL if missing). Describe the concrete block (story/task/file that must be completed first). |
| `acs_pending` | int[] | when `status: blocked` or `status: pending` — ACs NOT covered in that batch. |
| `tasks_pending` | int[] | when `status: blocked` or `status: pending` — tasks NOT covered. |
| `tests_pending` | string[] | when `status: blocked` or `status: pending` — test IDs (`T36`, `T40`, etc.) left without coverage. |
| `files` | string[] | optional. The part's files, one per line (`- ruta`) or `[a, b]`. With it, the plan's risk is measured by the part (see below). The lint stops a `files:` that is not a list. |
| `sensible` | like the top-level one | optional. Marks only this part as delicate. The top-level `sensible:` of the story marks all of them and a part does not undo it. |

**The part that counts.** The batch that `marker.js set-batch` records is the part being done. It counts if it declares a non-empty
`files:`, each of its files is in the story's `files_to_create` or `files_to_modify`, and none of its code files
is in the `files:` of another open part (a guide, a shared `suites.json` or `sprint-status.yaml` do not invalidate it). With
a part that counts, the risk, the delicate mark and the plan size measure the part plus what the change touches, and the
"has batches" rule does not count. The adversarial pass, its model and the story review still go by the whole
story. Without `files:`, the part counts with the files the story ties to the batch (see «Tie a file to a
batch», below) plus the ones it ties to none, which any batch may touch; `set-batch` prints that list. That way it is measured
with and without a coordinator. Two open batches that share a code file (tied to both, or in the `files:` of
both) do not count: the whole story is measured. A part without `files:` and with no tied file, or that does not count, is measured
as the whole story, as before.

**Consistency rules** (checked by `tycon-story-validator`):

- Every AC declared in `## Acceptance Criteria` must appear in exactly one `acs` (of some `done`/`in-progress` pipeline) **or** in `acs_pending` (of some `blocked`/`pending` pipeline). If an AC appears in no pipeline → **VAL-W7 WARNING** (orphan AC).
- An AC CANNOT appear in `acs` and `acs_pending` at the same time.
- A pipeline with `status: blocked` requires a non-empty `blocked_by` → **VAL-C6 CRITICAL** if missing.
- When all pipelines have `status: done`, the story's global `status` MUST be `done`.
- Two unfinished batches that name the same file must each say what they deliver alone (`delivers`); if neither is useful alone, they are merged into one → **VAL-W19 WARNING** if either does not say it.

**The run's batch.** The run that delivers a batch starts with `pipeline.js start --batch <name>`, or
records it with `marker.js set-batch <name>` (once, and the batch cannot be `done`). From then on, «Prepare the pull request»
asks for live evidence of that batch's criteria (`acs` ∪ `acs_pending`) plus those in no batch, not for
all of them. Closing a batch (`status: done`) asks for the evidence of the one being closed. Moving the story to `review` or `done`
asks for all of them.

**Tie a file to a batch.** The story ties a file to a batch in three ways: the comment on its line in
`files_to_modify` / `files_to_create` that names the batch (`# tanda <letra o nombre>`), a row of that batch's test
table (`tests` / `tests_pending`) that names it, or a task of that batch (`tasks` / `tasks_pending`)
that names it. If a batch's run changes a file tied ONLY to another batch, that other batch's criteria go back to
the matrix: the run touched what that batch delivers, and its evidence is asked for. A file that also names the run's
batch, or that names none, brings nothing back.

```yaml
files_to_modify:
  - src/api/orders.js        # tanda <la del backend>
  - web/src/OrdersPanel.tsx  # tanda <la de la pantalla>
```

**Cross-tracking by `tycon-deferral-tracker`**:

Any AC/task/test in `acs_pending` / `tasks_pending` / `tests_pending` must be documented in **at least one** of:
1. The repo's `tasks/todo.md` (line with `[DEF-{N.M}-{nombre}]`).
2. An Engram observation `type=decision` with keyword `Story {N.M}` and the type of the block.

If it is in NEITHER → **DEFTR-C1 CRITICAL** from the `tycon-deferral-tracker` advisor (Sprint 1+: blocks commit prep).

#### 1.2 Frontmatter — `followup_of:` / `followed_up_by:` back-links (when a story modifies another)

When a new story **modifies, recalibrates, fixes or extends** what another story already delivered (typically the original story is in `status: done` and/or signed off with the client), declare that relationship **explicitly** in the frontmatter.

It is **different from `depends_on:`** — `depends_on:` is implementation order ("X must be merged before Y"). `followup_of:` is semantic ("Y changes what X delivered"). A story may have `depends_on:` WITHOUT `followup_of:` (a story built on top of another without modifying it); rarely `followup_of:` without `depends_on:`.

##### `followup_of:` field — declared in the CHILD story (the one that comes to correct)

```yaml
---
epic: 13
story: "13.3.9"
title: "CaseRecapPanel — sección INCIDENCIAS desde incidencias reales del caso"
status: backlog
sprint: 3
priority: "P1"
approach: "[MODIFY]"
depends_on: ["13.3.4"]
followup_of:
  - id: "13.3.4"
    type: "fix"              # fix | scope-change | recalibration | gap-fill | extension
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
---
```

When the story modifies more than one earlier story (rare but valid):

```yaml
followup_of:
  - id: "3.2"
    type: "recalibration"
    summary: "Confirmación de listado — ahora también auto-genera CodigoBarras de etiqueta"
  - id: "2.3"
    type: "extension"
    summary: "Usa RemitoBuilderService.GenerateAsync del nuevo servicio"
```

**Schema:**

| Field | Type | Mandatory | Notes |
|---|---|---|---|
| `id` | string | yes | Story id of the parent (`"3.2"`, `"13.3.4"`), exactly as it appears in the parent's `story:` frontmatter. NOT the filename. |
| `type` | enum | yes | `fix` (corrects a bug/defect) · `scope-change` (explicit, signed scope change) · `recalibration` (re-interpretation after implementation) · `gap-fill` (covers an implicit AC not caught in the original spec) · `extension` (adds a capability on top of what was delivered). |
| `summary` | string | yes | One line — what changes compared with what the parent delivered. It does NOT repeat the story title (that is already there); it explains the delta. |

##### `followup_reason:` field — WHY the work had to be redone (2026-09-05)

Every story that declares `followup_of:` also states **the cause of the rework**, in a
top-level scalar of the frontmatter — **one per story**, even if it has several parents:

```yaml
followup_of:
  - id: "13.3.4"
    type: "fix"
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
followup_reason: defecto-propio
```

**It is not the same as `type:`.** `type` says *what kind of change it is* (an extension, a fix,
a recalibration); `followup_reason` says *why the work had to be redone*. Measured when the field was created:
`extension` is in 136 of the 285 stories with follow-up (48 %) and **is not rework** — an `extension` story can have cause
`cambio-de-requisito` (the client asked for more) or `descubrimiento` (using it showed something was missing).

The vocabulary is **closed** and lives in **one** file, `scripts/metrics/rework-causes.json`
(with the reason for each cause and each decision). This table **copies** it, and a test compares the
two — if they differ, the suite goes red:

| Cause | What it means |
|---|---|
| `defecto-propio` | What was delivered was wrong: a bug, a rule implemented badly, a case the spec did ask for and was not handled. |
| `cambio-de-requisito` | What was delivered did what the spec asked; the request changed afterwards (client, product, regulation). |
| `deuda-declarada` | The original story left something out **on purpose and wrote it down** (`pipelines:`, `TODO(Story-N-deferral)`); the follow-up pays it. |
| `descubrimiento` | Using what was delivered showed something nobody knew: a real case that neither the spec nor the client had foreseen. |

**What requires it and from whom.** `scripts/lib/lint-story-frontmatter.js`, in **each repo's pre-commit**,
requires it **only from the story being born** in that commit — with no git history — and **always** rejects
a value outside the table (`fix`, `Defecto-Propio`, free text: nothing is normalized).
A story with `followup_of:` that **already existed** without the field gets **a warning and is not stopped**: when
the field was created there were **285** in 9 repos, and requiring it from all of them would have turned the whole
team's pre-commit red on merge day — that is, the lint switched off within a week. Those 285 **are not filled in** (neither by
hand nor by deriving the cause from `type`: that would be making it up); the dashboard shows them as **«sin
declarar»** (not declared), a bar of its own with that word, broken down by the `type` they already carry as context.

**Where it is read.** `sdlc-stage-metrics.js` publishes `rework_por_causa` in the snapshot (the four
causes always present, `sin_declarar`, `fuera_de_vocabulario` with names, `total` = stories with
`followup_of:` in any state) and the dashboard draws the five bars on the card *«Por qué
volvió»* (why it came back). The signal to watch, written in the footer: **`cambio-de-requisito` going up while
`defecto-propio` goes down** — it is written by whoever caused the rework.

##### `followed_up_by:` field — AUTO-MAINTAINED back-link in the PARENT story

When a story with `followup_of:` is created, the `on-story-create.js` hook of the `tycon-story-followup-link` skill detects the field, identifies the parents, and emits a reminder so the agent updates each parent by adding a back-link:

```yaml
# En la story PADRE (ej. 13.3.4), agregar al frontmatter:
followed_up_by:
  - id: "13.3.9"
    date: "2026-05-18"       # fecha en que se creó la hija (ISO YYYY-MM-DD)
    type: "fix"              # mismo type que en el followup_of de la hija
    summary: "Sección INCIDENCIAS lee incidencias reales en vez de derivar del campo `estado`"
```

The back-link **must be in sync** with the child's `followup_of:` (same `id`, `type`, `summary`). The `tycon-story-validator` checks it with rule **[VAL-W10]** (bidirectional links): if child X declares `followup_of: [Y]` but Y does not have X in `followed_up_by:` → WARNING (and vice versa).

##### When NOT to use `followup_of:`

- A story built **on top of another** without modifying it → only `depends_on:`. Example: story `<A>` uses the auth contract of story `<B>` → `<A>` declares `depends_on: ["<B>"]`, NOT `followup_of:`.
- A story that **replaces** an earlier one (the earlier one becomes obsolete) → for now prefer creating the new one as `[CREATE]` and marking the old one as `status: superseded` in its Change Log (a `supersedes:` field stays as a TODO if the real case comes up).

##### Benefits

1. **Auditability** — open any original story and see at a glance all later recalibrations in its `followed_up_by:`.
2. **Client / signed proposal** — when reporting "Story `<N.M>` is done" you can add "...with 5 follow-ups that delivered X, Y, Z".
3. **Cross-sprint traceability** — a sprint 5 follow-up that modifies a story signed off in sprint 1 is visible from the signed one.
4. **Anti-drift** — the validator catches it when the bidirectional update is forgotten.

##### Tooling

- **Hook** (automatic, when the child is created): `tycon-story-followup-link/scripts/on-story-create.js` proposes the back-link.
- **Validator** (in the pipeline): `tycon-story-validator` rule VAL-W10 detects drift.
- **Bulk back-fill**: `~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js` syncs whole repositories.

#### 1.3 Frontmatter — extended fields (real schema)

Besides the base fields of the §1 example, real stories use these fields (formalized 2026-06-09 after an audit). Two are **STRONGLY RECOMMENDED** because there is tooling that uses them; the rest are optional.

| Field | Type | Level | Meaning |
|---|---|---|---|
| `files_to_create` | string[] | **STRONGLY RECOMMENDED** | Paths (relative to the repo) of the files the story creates. Used by the `on-edit.js` hook (detects edits outside the pipeline: touching a file that no in-progress story declares) and `pipeline.js risk-class` (classifies the surface of the change). Keep it in sync with the §9.5 "Files to create/modify" table. |
| `files_to_modify` | string[] | **STRONGLY RECOMMENDED** | Same, but for existing files the story modifies. Same consumers, plus the «screen story» detector (`lib/ui-signal.js`): with files declared in `files`/`files_to_create`/`files_to_modify`, the lists decide and the title or the `driver` stop counting. A story that touches a screen declares its frontend files there; if not, the closing warns in one line that it treats it as having no screen. |
| `driver` | multiline string (`\|`) | optional | Why the story exists: **2-3 lines at most** + link to the body section or the issue that tells the whole incident. See the anti-redundancy rule below. |
| `topics` | string[] | optional | Wiki topics (`specs/wiki/topics/`) the story touches — feeds the bidirectional story↔wiki lint. |
| `internal_scope` | bool | optional | `true` = internal story (harness/infra/tooling), not deliverable to the client — left out of the signed-scope reports. |
| `deprecated_reason` | string | optional | Why the story touches code that the repo declares **deprecated and frozen** (the `deprecated` list in `.tycon/advisors.yaml` or the file's `harness-deprecated:` mark): the fix that is needed. Without it, the validator stops (`VAL-C9`) and editing that file warns or stops; with it, a frozen file declared in `files_to_modify`/`files_to_create` goes through. A **dead** file is not touched even if the story brings the reason. |
| `owner` | string | optional | Human dev responsible for the story (not the agent that implements it). |
| `blocks` | string[] | optional | Inverse of `depends_on:` — stories that cannot start until this one is done. |
| `estimated_days` | number | optional | Kept for compatibility and nobody reads it: the estimate of the epic, of the plan and of the story lives in `.tycon/estimates.jsonl` of the stories repo, with each version (`guides/estimates.md`). |
| `signed_ac_ref` | string | optional | Reference to the AC of the document signed with the client that this story covers (see `guides/signed-scope-guardrails.md`). |
| `sensible:` | string | optional | The story is **delicate** even if its files do not say so: `seguridad` or `produccion`. Any non-empty value counts the same (a typo does not leave it as routine). The plan of a delicate story is always approved by the dev, never by the coordinator with the automatic review. It is read by `pipeline.js risk-class` (field `delicate`), which also marks as delicate a story that touches sensitive paths, the shared surface, production, the CI gate, the installer, a migration or the checks record. |
| `riesgo_alto_por:` | list | optional | What the machine cannot read in the files and makes the story high risk: one or more of `alcance`, `seguridad`, `dependencia-nueva`, `plata`, `clientes`, `personas` (`[plata]`, the scalar `plata` or a block list; `[]` does not count). With any value, `pipeline.js risk-class` gives `delicate` with rule `riesgo-alto-por`, which wins over the others, and a person approves the plan. A value outside the list stops the frontmatter lint. Separately, a story that declares a dependency file (`package.json`, `*.csproj`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle*`) gives rule `dependencias`. |

**🔴 Narrative anti-redundancy rule (`driver:` vs body):** the context/incident that motivates the story lives **ONLY ONCE** in the body (`## Origen` section or equivalent); `driver:` is limited to 2-3 lines + link to that section or to the issue. Reason: there were stories of 15-18K tokens that told the same incident 3-4 times (driver + Origen + root cause + Change Log), and each re-read by the advisors pays that cost on every pipeline iteration.

### 2. Title (H1)

It repeats the frontmatter title. Format: `Story {N}: {titulo descriptivo}`.

```markdown
# Story 2.3: POST /pedidos -- crear pedido, reservar stock, devolver el remito
```

### 3. Status

One line under the title:

```markdown
Status: ready-for-dev
```

### 4. Story ("As X, I want Y, so that Z" format)

```markdown
## Story

Como [rol/sistema],
quiero [accion concreta],
para [beneficio/razon].
```

It must be specific, not generic. Bad examples: "As a user I want to do things". Good examples: "As the Acme backend, I want that when the warehouse reports it finished packing an order (ARMADO_LISTO), the system saves the packing data in the order".

### 5. Acceptance Criteria

```markdown
## Acceptance Criteria
```

**Rules:**

- Numbered in sequence (1, 2, 3...)
- Grouped with H3 by topic (`### Autenticacion`, `### Flujo principal`, `### Edge cases`, etc.)
- Each AC is **verifiable** — it must be possible to turn it into a concrete test or query
- **BEHAVIOR ACs in Given/When/Then format (REQUIRED)**: `N. **Given** <estado inicial> **When** <acción> **Then** <resultado observable>`. It is already de facto practice and it is what `pipeline.js mech-check` parses to cross AC↔test. Simple declarative ACs (static config, constraint, no regression) may be numbered prose.
- They reference real files and methods of the codebase (with file name and line number when it applies)
- They never use vague language: NOT "should work fine", YES "returns 409 Conflict with a descriptive message"
- They include the **edge cases** and **errors** besides the happy path
- They include a `### No-regresion` section that lists what must NOT break
- **Mandatory failure-mode ACs**: for each path "what happens when X does not exist / fails / is empty / 0 results / timeout / no permissions" there must be an explicit AC. Happy path alone is not enough — most post-merge bugs come from unspecified failure modes (cell copy, a column that disappears, a misleading fallback, etc).
- **One AC per layout when there are N layouts**: if the story touches a component with several renders (mobile vs desktop, light vs dark, server vs client, etc), each affected layout must have its explicit AC. Do NOT assume that "<Componente>" covers all the component's paths.
- **Cross-story AC when there is integration**: if the story depends on another (`depends_on`) and they share a data contract (fields, body shape, events), include an explicit AC of "Story A writes X, Story B reads it as Y". Without it you get silent integration bugs (one side writes the field, the other side never reads it).
- **An AC with a discriminated-union response must list the behavior per status** (rule 2026-05-13): when a declared endpoint returns an envelope with a field `status: 'A' | 'B' | 'C' | ...` (discriminated union), the AC that lists the endpoint MUST list the expected behavior of the frontend/consumer **for each value of the discriminator**, even if N-1 of those behaviors are defined in other ACs. The list must be EITHER (a) in the same AC with bullets `status === 'X' → comportamiento Y`, OR (b) through an explicit cross-reference `ver AC #X para status='Y'`. NEVER leave implicit "the other statuses are covered by AC #N" without naming the status. Without this list, the `tycon-spec-first-checker` advisor cannot apply SPEC-W3 (which detects consumers that ignore the discriminator), and AC-coverage advisors do not detect UX dead code (a component that implements the 'ok' happy path but ignores `fallback-pdf-memory` loses the in-memory PDF in a real scenario with the printer unreachable).

**Which headings and which forms the harness reads.** The format above is the recommended one; the harness also reads what
other teams write, in a single place (`skills/tycon-pipeline/scripts/lib/story-checks.js`):

- **Headings**: `Acceptance Criteria` or `Criterios de aceptación`, and `Tests` for the table, in any upper or
  lower case and with `##` or `###` (the table, from `##` to `######`). `Tests corridos` is a heading of the evidence, not the table.
- **Criterion forms**, each with its name:
  - `titulo-ac`: `### AC-1 — título`
  - `numerada`: `1. **Given** … **When** … **Then** …` (the recommended one)
  - `vineta-ac`: `- **AC1**: texto`
  - `ac-negrita`: `**AC-1: título**`, with no bullet
  - `ac-vineta-titulada`: `- **AC1 — título**: texto`
  - `gherkin`: `GIVEN` / `WHEN` / `THEN`, loose or inside a `gherkin` block; each `GIVEN` opens a criterion
  - `dado`: `**Dado** … **Cuando** … **Entonces** …`; each `Dado` opens a criterion
- The first three take precedence: the others only count if the story uses none of them. `gherkin` and `dado` are numbered
  1, 2, 3… in the order they appear.
- Anything that fits none of them leaves the story **with no criteria**: the criteria coverage reviewer always runs, and the
  commit that moves it to `review` or `done` stops with the reason.

**A criterion with a number carries its bound: `@measure(...)`.** A criterion like «responds in under 2 s» comes out green
with a smoke run that takes 3 s if only the exit code is looked at. With the mark, the evidence matrix compares what the
smoke run measured with the bound the criterion writes:

```markdown
1. **Given** la consulta, **When** se pide, **Then** responde en menos de 2 s. @measure(duration < 2s)
2. **Given** 100 pedidos, **Then** el percentil 95 no pasa de 200 ms. @measure(p95 <= 200ms)
```

- `duration` is how long the smoke command took: the clock is taken by `smoke-run.sh`. Any other name
  (`[a-z][a-z0-9_.-]`, up to 40 letters) is what the command prints with `TYCON_MEASURE <nombre>=<valor><unidad>`.
- Operators `<`, `<=`, `>`, `>=`. `ms`, `s` and `min` convert into each other; any other unit must be equal letter by
  letter, and no unit only against no unit. Several marks on one criterion: all of them must hold.
- `@mide(duracion < 2s)` is also read. The guide shows `@measure`.
- A mark between backticks, in a code block or in a quote is an example, not a mark. An unreadable mark
  (`@measure(p95 ~ 2)`, `==`, an upper-case name) leaves the criterion `SIN-MEDICION` (no measurement): it is never ignored silently.
- The decision comes from the newest smoke run of the criterion that carries the measure and ran the app (`node --test`, a
  build gate or a simulated server do not count). If it needs repeating, the command does it and emits the aggregate (its p95).
- Outside the bound the criterion comes out `FUERA-DE-COTA` (out of bound); without the measure, `SIN-MEDICION`. Both block and have three
  ways out: measure again, change the criterion, or declare it in `runtime_not_verifiable:` with its proof and have the
  owner sign it. The signature is anchored to the declaration, as for any criterion; what was measured and the bound are shown before.

**What a measurement promises and what it does not.** It holds for one run, in one environment: that of the machine that ran the smoke run,
which goes in its provenance. It is not a load test and says nothing about production, and the CI server does not see it (it only checks
that files exist). A `TYCON_MEASURE` value is what the command says: the harness guarantees it was not edited after
the run, not that the number is an honest measurement. `duration_ms` is taken by the harness.

### 6. Tests (table)

```markdown
### Tests ({N} verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `NombreDelTest_Descriptivo` | 1 | unit | Descripcion del escenario | Resultado concreto esperado |
| T2 | `OtroTest_Descriptivo` | 1,3 | integration | Descripcion del escenario | Resultado concreto esperado |
```

**Rules:**

- The first column (`#`) holds the T-ID (`T1`, `T2`, … / `E1` for E2E) — it is one of the keys `pipeline.js mech-check` uses to match table ↔ code
- Test name according to the organization's `test_names` rule (`pipeline.js org-rules`): `any` (built-in) asks for
  no style; `pascal` asks for `PascalCase_Descriptivo` (e.g. `PostPedidos_NoApiKey_Returns401`); `snake` asks for
  `snake_case` (e.g. `test_post_pedidos_sin_clave_da_401`)
- **`AC` column (MANDATORY)**: list of AC numbers the test covers (e.g. `1` or `1,3`). Every AC must appear in at least one row (GOLD rule #2, checked mechanically by ACCOV-C5)
- **`Nivel` column (MANDATORY)**: `unit` | `integration` | `e2e`
- **`Archivos` column (OPTIONAL)**: the declared files (`files_to_modify` / `files_to_create`, written the same way) that
  the test exercises, separated by commas. It keeps a small change from forcing you to repeat all the smoke runs: when
  a code file changes, the matrix expires only the evidence of the criteria whose tests exercise it, and that of
  the others still counts (it says so as a warning). Why the story writes it and not whoever runs the smoke run: it is fixed
  before coding, the validator looks at it, and it is not chosen by the same agent that saves itself repeating the test. A criterion
  with some test without this cell, or with no test at all, expires as always (every change expires it). A name the
  story does not declare gets a warning and its criterion expires as always: a typo does not leave evidence unexpired.
  Example: `| E3 | \`MapaMuestraLosPuntos\` | 2 | e2e | … | … | \`web/MapaDelEditor.tsx\`, \`web/puntos.ts\` |`
- The scenario describes the input conditions
- The expected result is concrete (HTTP code, emitted event, final state)
- They cover: happy path, errors, edge cases, idempotency, no regression

**AC↔test contract in code (mandatory tagging):** each implemented test declares in the code which story and AC it belongs to:

- **xUnit (.NET)**: `[Trait("Story", "N.M")]` + `[Trait("AC", "1")]` on each test (one `Trait("AC", ...)` per covered AC).
- **vitest / Playwright**: literal tag `@story-N.M` and `@ac-1` in the title of the `describe`/`test` (e.g. `test('@story-4.5 @ac-1 rechaza payload vacío', ...)`).
- **pytest**: `@pytest.mark.story("N.M")` + `@pytest.mark.ac(1)` on the function, or `@story-N.M @ac-1` in its docstring
  or in the `-k` of the name (e.g. `def test_story_4_5_ac_1_rechaza_payload_vacio`).
- **A runner declared by the organization** (Go, Maven, Gradle, Karma or another): the T-ID or the tag
  `@story-N.M @ac-1` in the test name, which is what reaches the JUnit report.

**Why:** it allows **MECHANICAL** coverage checking — `pipeline.js mech-check` crosses the `### Tests` table against the code (matches by Trait/tag/T-ID/name) and applies ACCOV-C1 (declared test that does not exist) and ACCOV-C5 (AC without a test), instead of relying on semantic matching by an LLM. It also lets you run the coverage of a single AC: `dotnet test --filter "AC=1"`.

**`Given/Fixture` sub-block (OPTIONAL, for non-trivial tests):** under the table, one bullet per test that needs it, with the concrete data to seed, the request payload and the expected response — everything an agent needs to write the RED test **before** the code (ATDD, pipeline sub-step 4.0). Format:

```markdown
#### Given/Fixture

- **T3** — Seed: pedido `P-123` con bolsa `C-1` en etapa ARMADO, etiqueta `E-1` impresa.
  Request: `POST /api/ceibo/armados/fin { "etiquetaId": "E-1" }`.
  Response esperada: `409 Conflict { "error": "Etiqueta ya finalizada" }`.
```

#### 6.1 Mandatory E2E rule (stories with frontend components)

If the story creates or modifies **a screen**, the `### Tests` table MUST include at least **1 implemented E2E smoke test** as part of the story — not as "planned for later". What counts as a screen is set by the organization's `screen_test` rule (`pipeline.js org-rules`): `ui` (built-in) = `.tsx`, `.jsx`, `.svelte` and `.vue`; `react` = only `.tsx` and `.jsx`; `off` = the rule is not required, and the story's closing says so.

The E2E test must:
- Be in a concrete spec file **already created** (e.g. `tests/e2e/story-N-M-descripcion.spec.ts`)
- Have all its `data-testid` confirmed as existing in the code
- Be running (no skip) before the story moves to `review`
- Check at least: the main component mounts and is visible (wiring smoke)

Format of the row in the Tests table:

```markdown
| E1 | `E2E_NombreFeature_Escenario` | 3 | e2e | `story-N-M.spec.ts::NombreFuncion` — descripcion breve | Componente visible / data-status correcto |
```

E2E rows use the prefix `E` (E1, E2, …) to tell them apart from unit tests (T1, T2, …).

**Anti-pattern to avoid**: declaring E2E in a separate "Planned" block with no spec file and no sprint assigned. Why: E2E tests set apart as "Planned" with no owner stay as open-ended technical debt (measured: 10 in one story).

### 7. Tasks / Subtasks

```markdown
## Tasks / Subtasks

- [ ] [SEQ] Task 1: Descripcion concreta
  - [ ] Subtask con detalle
- [ ] [SEQ] Task 2: Siguiente tarea
- [ ] [PAR] Task 3: Tarea paralelizable (no depende de las anteriores)
```

**Rules:**

- `[SEQ]` = sequential, depends on the previous one. `[PAR]` = can run in parallel
- Each task references the ACs it implements: `(AC: 1-6)`
- Subtasks are checkboxes that get ticked when completed
- The first task is ALWAYS **Database safeguard** or **State safeguard**: check that the spec's assumptions match the reality of the code/database

### 8. Task Dependencies

```markdown
### Task Dependencies

T1 → T2 → T3 → T4 (secuencial)
T5 puede ejecutarse en paralelo con T3-T4
```

### 9. Dev Notes

The most important section. It holds ALL the context the dev agent needs.

```markdown
## Dev Notes
```

**Convention for citing code that the story itself modifies (2026-09-06 · `VAL-W14`):** when the
story cites a location INSIDE a file it is going to modify, cite the **member**
(method, property, class) as a stable identity — «`ValidatePayload` in
`Boundary/PluginBoundary.cs`» — and the line number, if any, goes as a hint («~142»), not as an
authoritative reference: any fix the story itself applies to its diff shifts the
lines it cites about itself (measured: three desyncs in one run, one
CRITICAL in Step 1). Citations to files the story does NOT modify may carry `archivo:línea`,
which is stable there. The validator warns about it as `VAL-W14`; it does not block.

#### 9.1 What exists today

Split into two subsections:

```markdown
### Que existe hoy

#### En [sistema fuente] (source of truth)

**Archivo:** `ruta/al/archivo.ts` (N lineas)
- **Que hace:** Descripcion breve
- **Metodos clave:**
  - `metodo()` linea XX → que hace
  - Logica real (con snippet de codigo):
    ```csharp
    // Codigo REAL copiado del archivo fuente
    var remito = await depositoApi.GetRemitoAsync(pedidoId);
    ```

#### En Acme (lo que ya tenemos)

- **Archivo:** `src/AcmeBackend/Features/Pedidos/PedidoStore.cs`:
  - `TryMarcarArmadoAsync(pedidoId)` linea 107 — transicion atomica, retorna bool
- **No existe:** [listar lo que hay que crear]
```

**CRITICAL rules:**

- Every reference to a file **MUST exist in the codebase** — check before writing
- Every reference to a method **MUST include the file name and the line**
- If a method does NOT exist, say explicitly "does NOT exist — must be created"
- Include snippets of REAL (not invented) code from the source system

#### 9.2 Verified reference pattern (MANDATORY in every backend story)

This section is **mandatory in every story that implements backend code** — with no exception for `approach`. Its purpose: make sure the story is born anchored to a pattern ALREADY SOLVED in the sibling projects, and not to an invented fix.

**TYCON team context**: there are 4 sibling Bizuit .NET plugins (`NimboBackend`, `TotoraBackend`, `FRESNOBZExtBackend`, `CeiboBackend`) + the plugin framework repo. Almost any structural decision —DI registration, access to `BizuitUserContext`, lifecycle of hubs / hosted services, transactions, endpoint routing, the plugin loader contract— IS ALREADY solved in a uniform way in those siblings. A backend story that takes a decision of that kind WITHOUT citing how the siblings do it is, by definition, inventing.

The section must contain **one of two things**:

**(A) The verified sibling pattern** — when it exists (the normal case):

```markdown
### Patron de referencia verificado

**Patron**: <que se hace y como, en una frase>

| Proyecto hermano | Ancla `archivo:linea` (o comando `grep`) | Que se verifico exactamente |
|---|---|---|
| NimboBackend | `Features/Projects/ProjectsEndpoints.cs:91` | Abri el archivo: el handler recibe `BizuitUserContext userContext` como parametro, NO por ctor. |
| TotoraBackend | `grep -rl "readonly BizuitUserContext" src/TotoraBackend` | 0 resultados — ningun servicio ctor-inyecta el contexto. Corrido 2026-05-17. |
| FRESNOBZExtBackend | idem grep | 0 resultados. |

**Conteo / evidencia dura**: <ej: "3/3 plugins hermanos: 0 servicios con ctor-injection; Ceibo es el unico outlier con 12">.
```

**(B) The explicit statement that it does NOT apply** — only when it is genuinely true:

```markdown
### Patron de referencia verificado

**No aplica**: <razon concreta>. Verifique los 3 plugins hermanos (`grep ...` sobre Nimbo / Totora / FRESNO) y ninguno tiene un patron equivalente para <concern>. Esta story crea el patron por primera vez.
```

**CRITICAL rules of this section**:

- Each `archivo:linea` anchor (or `grep` with its exact command) **must RESOLVE**: the file exists, the line is in range, and the pattern is really there. Whoever writes the story MUST have opened the file. The validator checks it (`VAL-C8`) and the `tycon-sibling-pattern-reviewer` advisor confirms it by opening the sibling files.
- "What was checked exactly" is **specific and verifiable** — NOT a generic description. Bad: "Nimbo handles the user context well". Good: "opened `ProjectsEndpoints.cs:91`, the handler receives `BizuitUserContext userContext` as a parameter; `grep readonly BizuitUserContext` → 0".
- 🔴 **Basing this section on an unverified assumption is forbidden**. If the source of the pattern is a research agent that said "I assume", "probably", "I think", or "I could not confirm" → that is NOT evidence. You have to go to the sibling's code, open the file, and confirm. An "(I assume)" from a research agent is enough for a story to propose the fix opposite to the real pattern.
- Option (B) "does not apply" **is not an escape hatch**: if the advisor finds that ≥2 sibling plugins DO have the pattern for that concern, statement (B) is false and is reported CRITICAL (`XPAT-C3`). Use (B) only after really searching.

> 📌 **Model to follow**: this section well written brings a count per plugin, concrete anchors, and what was checked (example (A) above). The opposite —a story that proposes the fix OPPOSITE to the real pattern (registering `BizuitUserContext` in DI) without any cross-project evidence— is exactly the case this rule exists to prevent.

#### 9.3 What to do (the delta)

Numbered list of what must be implemented, with the key differences vs the source system.

```markdown
### Que hay que hacer (la delta)

1. Crear X que hace Y (en Totora esto es Z)
2. Adaptar W cambiando A por B (Totora usa A, Pacara usa B)

**Diferencias clave vs [fuente]:**
- Fuente: [como era]. Pacara: [como sera].
```

#### 9.4 Concrete implementation (optional, for complex stories)

Example code or pseudo-code that shows the exact approach.

```markdown
### Implementacion concreta

**CRITICO: Read-modify-write para metadata.**
```csharp
// Patron correcto:
var currentJson = await repo.GetMetadataAsync(id);
var metadata = JsonSerializer.Deserialize<Dictionary<string, object>>(currentJson);
metadata["field"] = newValue;
await repo.UpdateMetadataAsync(id, JsonSerializer.Serialize(metadata));
```
```

#### 9.5 Files to create/modify

```markdown
### Archivos a crear/modificar

| Accion | Archivo |
|--------|---------|
| Crear | `src/AcmeBackend/Features/Pedidos/Webhooks/OrderSyncHandler.cs` |
| Modificar | `src/AcmeBackend/Features/Pedidos/StockManager.cs` (agregar ReleaseReservaIfHeldAsync) |
```

#### 9.6 What NOT to do

Explicit list of anti-patterns, common mistakes, and scope boundaries.

```markdown
### Lo que NO hay que hacer

- **NO usar JSON_MODIFY de SQL Server** — read-modify-write en C# (leccion de sesion anterior)
- **NO crear el registro del cliente** en Path B — ya fue creado por POST /end
- **NO implementar heartbeat** (story separada)
- **NO aceptar extension en el request** (el backend la asigna, no el frontend)
```

**Rules:**

- Each item explains WHY it must not be done
- Include lessons from earlier stories
- Define the scope limits (what is NOT part of this story)

#### 9.7 How to verify it works

```markdown
### Como verificar que funciona

```bash
# Tests unitarios
dotnet test --filter "NombreDelTest"

# Test manual con DevHost
curl -X POST http://localhost:5002/api/... | jq
# Esperado: 201 con pedidoId
```
```

Include **copy-paste runnable** commands, not vague descriptions.

#### 9.8 Database safeguard (when it applies)

```markdown
### Salvaguarda de BD (obligatoria antes de implementar)

1. `SELECT ... FROM ... WHERE ...` — verificar que X existe
2. Si CUALQUIER asuncion no coincide → DETENERSE → corregir spec primero
```

### 10. Dev Agent Record (filled in AFTER implementing)

The Dev Agent Record is **mandatory** before committing. It is the evidence that the story was implemented correctly. NEVER commit without filling it in.

```markdown
## Dev Agent Record

### Agent Model Used

Modelo exacto usado para implementar, tal como lo informa la sesión (el mismo que va en el `Co-Authored-By` del commit).

### Debug Log References

Resultados de compilacion y tests. Debe incluir:
- Comando de build + resultado (0 errores o lista de errores resueltos)
- Comando de tests especificos + resultado (N/N PASS)
- Suite completa: si corrió (test-gate del pipeline, portón de `/tycon-merge-to-main` o cuando el dev la pide) → comando + resultado; si no, anotar "queda para el portón" (ver `guides/test-execution-discipline.md`)
- Hallazgos/spec anchors descubiertos durante la implementacion

Ejemplo:
- Build: `dotnet build` — 0 errores
- Tests: `dotnet test --filter "OrderSync"` — 9/9 PASS
- Suite completa (`test-gate.sh` del pipeline): 2725/2725 PASS, 0 regresiones
- Spec anchor: story decia `ProviderId = 1` (el proveedor A), el proveedor B es ProviderId=2
- Spec anchor: story decia "Crear PedidosEndpoints.cs" pero ya existia de la story <N.M>

### Completion Notes List

Resumen tecnico de lo que se implemento. Una linea por cada decision o componente relevante.
No es prosa — es una lista de hechos verificables.

Ejemplo:
- OrderSyncHandler: Path A stores WebhookData + extends TTL 300s; Path B enriches metadata via read-modify-write
- ReleaseReservaIfHeldAsync added to StockManager — removes the hold (stock freed implicitly)
- Metadata merge is idempotent — warehouse data overwrites the estimates
- Order: stopPolling → observer.stop → close panel → beforeunload → DOM → removeAllListeners → store.reset

### File List

TODOS los archivos creados o modificados. Formato: `ruta/archivo.ext (NEW | MODIFIED — descripcion)`.
Si un archivo fue modificado, indicar QUE se cambio.

Ejemplo:
- src/AcmeBackend/Features/Pedidos/Webhooks/OrderSyncHandler.cs (NEW)
- src/AcmeBackend/Features/Pedidos/StockManager.cs (MODIFIED — added ReleaseReservaIfHeldAsync)
- tests/AcmeBackend.Tests/Features/Pedidos/OrderSyncHandlerTests.cs (NEW — 9 tests)

### Change Log

Una linea por sesion de trabajo. Formato: `YYYY-MM-DD: Descripcion breve (Autor/Agente)`.

Ejemplo:
- 2026-04-15: Story implementada y verificada. 9/9 tests PASS, 2725/2725 full suite PASS.
- 2026-04-16: Fix spec anchor ProviderId — era 1012 no 1. Re-tested.
```

**Dev Agent Record rules:**

1. **Fill it in BEFORE committing** — without a complete record, nothing is committed
2. **Tick ALL tasks `[x]`** in the Tasks/Subtasks section with results
3. **Spec anchors**: if during implementation you find the story had an error (missing file, renamed method, wrong ID), document it in the Debug Log as "Spec anchor: story said X, reality is Y"
4. **Exhaustive File List**: if you forget a file, the reviewer cannot check the implementation is complete
5. **Actionable Completion Notes**: not "the story was implemented" but WHAT was implemented and HOW

### 10b. Adjustments after sign-off (optional)

Wording adjustments that come up while the plan is being reviewed (an example, a word, the findings of the previous
round) are not written into the body until the plan is signed: the plan review is tied to what defines the build,
and this section does not count. One line per adjustment; it is marked `- [x]` once it is in the body. The code
reviewers and the adversarial pass read it as part of what was asked, and a story in `done` with an unmarked adjustment is not
committed.

```markdown
## Ajustes después de la firma

- [ ] AC 2: el ejemplo dice «tres días», va «cinco días hábiles».
- [x] Dev Notes: «borrar» por «archivar» (ya en el cuerpo).
```

### 11. Follow-ups and post-sign-off changes (optional, derived from `followed_up_by:`)

For `done` or `review` stories that had later follow-ups (recalibrations, fixes, scope changes — declared in the frontmatter's `followed_up_by:`), add at the end of the body a human-friendly block that sums up what the story delivers *today* compared with what was originally signed.

It is **OPTIONAL** — the frontmatter (`followed_up_by:`) is the source of truth for tooling. The table in the body is only for humans who open the file to read it (PM, client, external auditor).

```markdown
## Follow-ups y cambios post-firma

> Esta story se firmó/entregó originalmente en Sprint 3 con el scope listado arriba. Las siguientes stories posteriores modifican o extienden ese entregable. Ver frontmatter `followed_up_by:` para metadata estructurada.

| # | Story | Fecha | Tipo | Qué cambia |
|---|---|---|---|---|
| 1 | [13.3.9](./13-3-9-caserecappanel-incidencias-reales.md) | 2026-05-18 | fix | INCIDENCIAS muestra incidencias reales (no derivado de `estado`) |
| 2 | [13.3.10](./13-3-10-caserecappanel-loading-error-states.md) | 2026-05-18 | gap-fill | Loading skeleton + error banner separados |
| 3 | [13.3.12](./13-3-12-uselistadostore-scope-por-pedidoid.md) | 2026-05-19 | fix | useListadoStore scope por pedidoId — fin del singleton global |
```

To generate the table automatically from the frontmatter:
```bash
node ~/.claude/tycon-harness/scripts/tools/tycon-backfill-followups.js \
  --dir specs/stories --story <N.M> --render-table
```

### 12. Behavior changes (when the story changes what an existing command does)

If the story modifies a command that exists in `main`, «Check it live» runs it with the `main` version and with the
change, and compares the two outputs (`smoke-run.sh --compare`, see `steps/step-10-live-check.md`). A difference the
story does not declare stops «Prepare the pull request». It is declared in this section, one line per command:

```markdown
## Cambios de comportamiento

- node {raiz}/scripts/tool.js get: ahora el saludo lleva signo de exclamación
- node {raiz}/scripts/tool.js : la ayuda nombra el subcomando nuevo
```

The matching rule: a line declares a smoke run's command if the text before the «:» is that command (what comes
after `--` in the smoke run, as the record stores it, with `{raiz}` literal) or a prefix of it that ends in a
space. It may go between backticks. Declaring is paperwork: it does not trigger the reviewers' round.

The exemption for a command that cannot be compared **does not go in the frontmatter**: a `compare_exempt:` line does not exempt anything.
It goes through `marker.js compare-waiver --story <historia> --command <candidato> --reason "<por qué>"`, which asks for the
`compare-waiver` signature (level 1: from the owner, or from the coordinator if the team profile delegates it).

---

## GOLD rules (mandatory quality)

### 1. Anchoring to real code

- **EVERY** reference to files, methods, lines must exist in the codebase
- If the story references `PedidoStore.TryMarcarArmadoAsync()`, that method MUST exist
- If it does NOT exist, the story must say "does NOT exist — must be created in this story"
- Check with `grep` before writing the story

### 2. Verifiability

- Each AC must be possible to turn into a concrete test or query
- If you cannot write a test for an AC, the AC is vague — rewrite it
- The tests in the table must be enough to verify ALL the ACs

### 3. No reinventing

- Identify existing code that is reused (with file and line)
- If there is an existing helper, service, or pattern, reference it
- Never create something that already exists — the "What exists today" section prevents this

### 4. Disaster prevention

- The "What NOT to do" section anticipates common mistakes
- Include lessons from earlier stories (from `tasks/lessons.md`)
- Anticipate problems with DI (Singleton/Scoped), locale, mocking, encoding

### 5. Optimization for the LLM dev agent

- Clear, concise, actionable — no unnecessary prose
- The dev agent ONLY has this file — all the context must be here
- Snippets of source-system code included (not "see file X")
- Copy-paste runnable verification commands

### 6. Dev validation (pre-implementation)

Before implementing, the dev agent must be able to answer YES to all of these:

- Can I implement without questions?
- Does anything feel invented or assumed?
- Is critical context missing?
- Is the verification runnable?
- Do the referenced files exist?

If the answer to any of them is NO → fix the story before writing code.

### 7. Dev Agent Record completeness

NEVER commit without filling in:

- Tasks ticked `[x]` with results
- Agent Model Used
- Debug Log with findings
- Completion Notes
- File List with ALL new/modified files
- Change Log with date

### 8. Failure mode coverage

Every story must have explicit ACs for the paths where something does not exist / fails / is empty. If the story is pure happy path, it is incomplete.

Before marking a story `ready-for-dev`, answer these questions and add an AC for each YES:

- What happens if the referenced entity does not exist in the system (canonical without mapping, user without postal code, item without price, etc)? → AC with the expected copy/behavior.
- What happens if an external call fails (a 5xx from the provider, LLM timeout, region resolve fail)? → AC with fallback or message to the user.
- What happens if the collection is empty (search with 0 results, list with no items, store with no matches)? → AC with the expected render (do not assume "it gets filtered").
- What happens if the component renders in another layout/viewport/theme? → AC per affected layout.
- What happens if story B (which depends on this one) reads a field this new one writes? → AC for the data contract.

**Working rule**: for each happy-path AC, there must be at least 1 related failure-mode AC. If the AC list is N happy-path and 0 failure, the story is incomplete.

**Lessons from the field**:

- Story with a single AC `"render con cell isGeneric=true,kind='exact'"` → post-merge bug: the matrix has 2 layouts (mobile + desktop) and only one was implemented. An explicit AC per layout was missing.
- Story with AC `"recompare con la marca elegida"` → post-merge bug: the orchestrator never read the body field because another story (that persisted to the DB) took precedence. A cross-story AC was missing.
- Story with AC `"si el super no tiene la marca, marcar unavailable"` but without AC `"copy del cell unavailable cuando el motivo es por preferencia explicita"` → post-merge bug: the cell showed the generic copy "Este super no lo vende" instead of "No vende {marca}". The failure-mode AC with the copy detail was missing.

### 9. Verified reference pattern (no cross-project invention)

**Every backend story** must include the "Verified reference pattern" section (§9.2). It is NOT optional and it does NOT depend on the self-declared `approach`.

- If the story's structural decision (DI, auth / user-context, lifecycle, transactions, routing, plugin loader contract, etc.) IS ALREADY solved in a sibling project → the story MUST cite that pattern with `archivo:linea` anchors (or `grep` with the exact command) that **resolve**, and open the file to confirm it.
- If there is genuinely no sibling pattern → the story MUST state it explicitly with the reason and the evidence of having searched (option B of §9.2).
- **Leaving out the section = MALFORMED story.** A backend story with no cited pattern and no "does not apply" statement cannot be validated — nobody knows whether it reuses or invents.
- 🔴 An unverified assumption ("I assume", "probably", "I could not confirm" from a research agent) is **NEVER** a valid basis for this section. Verifying means going to the sibling's code and opening the file.

**Why**: a runtime error ("Unable to resolve service for type `BizuitUserContext`") can produce an `[ADAPT]` story whose fix is THE OPPOSITE of the real pattern (registering `BizuitUserContext` in DI; the sibling plugins NEVER do that — they receive it as a handler parameter). Without this section, the story is written and validated without citing or checking the sibling pattern. With section §9.2 mandatory, the author opens the sibling plugins and sees the real pattern before writing a single line.

---

## Minimal complete example

```markdown
---
epic: 7
story: "7.1"
title: "POST /pedidos/{pedidoId}/despachar -- pedir el retiro al transporte"
status: ready-for-dev
sprint: 5
priority: "P0"
approach: "[CREATE]"
depends_on: ["2.3"]
---

# Story 7.1: POST /pedidos/{pedidoId}/despachar -- pedir el retiro al transporte

Status: ready-for-dev

## Story

Como panel de pedidos de Acme,
quiero un endpoint POST /pedidos/{pedidoId}/despachar que pida el retiro a la API del transporte,
para que el backend inicie el despacho en vez de depender de que el operador lo cargue a mano.

## Acceptance Criteria

### Flujo principal
1. Valida que el pedido existe y esta en estado `Armado`
2. Llama a la API del transporte: `POST /v1/retiros?remito={remito}&sucursal={sucursal}&urgente=false`
3. Transiciona el pedido a `EnDespacho`
4. Retorna 200 OK con `{ pedidoId, status: "despachando" }`

### Errores
5. Pedido no encontrado → 404 Not Found
6. Pedido vencido → 410 Gone
7. Estado no es `Armado` → 409 Conflict
8. La API del transporte falla → 502 Bad Gateway

### Tests (5 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Despachar_PedidoArmado_Returns200` | 1,2,3,4 | integration | Pedido en Armado | 200 con status=despachando |
| T2 | `Despachar_PedidoNotFound_Returns404` | 5 | integration | pedidoId inexistente | 404 |
| T3 | `Despachar_PedidoVencido_Returns410` | 6 | integration | Pedido con plazo vencido | 410 |
| T4 | `Despachar_WrongState_Returns409` | 7 | integration | Pedido en Entregado | 409 |
| T5 | `Despachar_TransporteFails_Returns502` | 8 | integration | API retorna error | 502 |

## Tasks / Subtasks

- [ ] [SEQ] Task 1: Salvaguarda — verificar ITransporteService, PedidosService, PedidosEndpoints existen
- [ ] [SEQ] Task 2: Agregar PedirRetiroAsync a ITransporteService + TransporteApiService
- [ ] [SEQ] Task 3: Agregar DespacharAsync a PedidosService
- [ ] [SEQ] Task 4: Agregar endpoint POST /pedidos/{pedidoId}/despachar a PedidosEndpoints
- [ ] [SEQ] Task 5: Tests + verificacion

### Task Dependencies

T1 → T2 → T3 → T4 → T5

## Dev Notes

### Que existe hoy

#### En Acme

- **Archivo:** `src/AcmeBackend/Services/TransporteApiService.cs`
  - `MakeRequestAsync()` linea 77 — request autenticado con HMAC-SHA1 a la API del transporte
  - Patron para agregar nuevo metodo: copiar `GetCotizacionAsync()` linea 123
- **Archivo:** `src/AcmeBackend/Features/Pedidos/PedidosService.cs`
  - `CrearPedidoAsync()` linea 57 — crea el pedido, reserva stock
  - El pedido tiene `Remito` y `Sucursal` que necesitamos para pedir el retiro
- **No existe:** metodo `PedirRetiroAsync`, metodo `DespacharAsync`, endpoint `/despachar`

### Que hay que hacer (la delta)

1. `PedirRetiroAsync` en TransporteApiService: `POST /v1/retiros` con params remito, sucursal, urgente
2. `DespacharAsync` en PedidosService: get pedido → validate state → pedir retiro → transition to EnDespacho
3. Endpoint `POST /pedidos/{pedidoId}/despachar` en PedidosEndpoints: auth + error mapping

### Lo que NO hay que hacer

- **NO pedir el retiro desde el panel** — el backend lo dispara contra la API del transporte
- **NO usar urgente=true** — con urgente=false el transporte agrupa los retiros de la sucursal (un solo viaje)
- **NO cambiar el flujo de POST /pedidos** — ese endpoint sigue igual, solo crea el pedido

### Como verificar que funciona

dotnet build
dotnet test --filter "Despachar"

## Dev Agent Record

(se completa despues de implementar)
```

---

## Quick checklist to validate a story

- [ ] Complete frontmatter (epic, story, title, status, sprint, priority, approach, depends_on)
- [ ] Frontmatter: `files_to_create` / `files_to_modify` declared (strongly recommended — used by `on-edit.js` and `pipeline.js risk-class`)
- [ ] Frontmatter: `driver:` of 2-3 lines at most + link (the full incident lives ONLY once in the body — §1.3)
- [ ] Story in "As X, I want Y, so that Z" format
- [ ] Numbered, verifiable ACs, with real files referenced
- [ ] Behavior ACs in Given/When/Then format (simple declarative ones may be numbered prose)
- [ ] Test table with name, scenario, result + `AC` and `Nivel` columns (MANDATORY — used by `pipeline.js mech-check`)
- [ ] Every AC covered by at least one test in the `AC` column (ACCOV-C5)
- [ ] Tasks with `[SEQ]`/`[PAR]`, first task is a safeguard
- [ ] Explicit task dependencies
- [ ] Dev Notes: "What exists today" with real files and lines
- [ ] Dev Notes: "Verified reference pattern" (MANDATORY in every backend story) — sibling pattern with `archivo:linea` anchors that resolve, OR explicit "does not apply" statement with evidence
- [ ] Dev Notes: "What to do" with the delta
- [ ] Dev Notes: "What NOT to do" with reasons
- [ ] Dev Notes: "How to verify" with runnable commands
- [ ] Every referenced file/method EXISTS in the codebase (or says "does NOT exist")
- [ ] No unnecessary prose — everything is actionable
