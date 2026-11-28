# Git Commit Conventions — TYCON guide

In Spanish: [git-commit-conventions.md](git-commit-conventions.md).

A single guide for commits, merges and pushes in every TYCON repo (FRESNO, Ebano, Totora, Pacara and the platform forms repo). It brings together the rules scattered across each repo's `CLAUDE.md`.

---

## Rule #0 — Explicit authorization (NO COMMIT / NO PUSH without consent)

**In a pipeline run or in a signed fast path, the person approves the pull request, not the commit.** The
agent commits and pushes its working branch without asking, after closing «Preparar el pull request» (Prepare the pull
request); the hook records it in `gates.log`. Opening or merging a pull request, and pushing to a shared branch (`main`,
`master`, `dev`, `release/*`), asks in the permission window, with the run's evidence, and stops if the pull request is
not prepared or if the code changed since then.

**Outside of that, UNDER NO CIRCUMSTANCES run `git commit` or `git push` without the user's explicit consent.**

- NEVER run `git commit` automatically when the implementation is done.
- NEVER run `git push` unless the user asks for it in those words.
- "Implement story X" / "fix bug Y" / "add feature Z" does **NOT** mean commit. It means leaving the modified files and waiting for review.
- The user asks explicitly with phrases like: "commit it", "make a commit", "take it to main", "push it", "merge to main". Without those words (or clear equivalents), the git history is not touched.
- If you are not sure whether a commit is expected, **ask first**. An unrequested commit costs more to revert than a "do you want me to commit?" costs to answer.

---

## Commit format — HEREDOC + separate trailer

Always use a **HEREDOC** with a multi-line message. The `Co-Authored-By` trailer goes **separated from the body by a blank line** — that way a pipeline that publishes release notes does not pick it up as part of the note.

### Literal example (copy-paste):

```bash
git commit -m "$(cat <<'EOF'
feat(pedidos): agregar endpoint POST /pedidos/{pedidoId}/despachar

- Nuevo método PedirRetiroAsync en TransporteApiService (HMAC-SHA1 auth)
- DespacharAsync en PedidosService: valida estado Armado, pide el retiro a la API del transporte
- Endpoint mapea 404/409/410/502 según estado de la sesión
- Tests: 4/4 PASS, suite completa 2725/2725 PASS (test-gate del pipeline)

Co-Authored-By: <modelo exacto de la sesión> <noreply@anthropic.com>
EOF
)"
```

### HEREDOC rules

1. Delimiter: `<<'EOF'` with single quotes — prevents expansion of variables/backticks in the message.
2. First line: a short conventional-commit title (`feat|fix|refactor|docs|test|chore|perf|style(scope): descripción`). At most ~72 characters.
3. A blank line, then a body with bullets describing **what + why**.
4. A blank line, then the `Co-Authored-By:` trailer with the exact model that did the implementation, as the
   session reports it (under Codex, the matching gpt model) — never the one from an example.
5. Close with `EOF` and `)"`.

---

## Descriptive message — commits are documentation AND release notes

In repos whose pipeline publishes commit messages as release notes, the messages are **visible to customers**. They are not just internal history.

### Rules

- **NEVER** generic messages: `"fix"`, `"update"`, `"sync"`, `"trigger rebuild"`, `"wip"`, `"changes"`, `"merge"`.
- **ALWAYS** lead with **WHAT** changed and **WHY**. The how is already in the diff.
- Even if the hook rejects, even if there is a merge conflict, even if you are in a hurry — **take 5 seconds** to write something descriptive. The message stays in the release note forever.
- If the commit only exists to re-trigger a pipeline, say so explicitly and describe what is expected: `chore(ci): re-trigger deploy pipeline tras fix de secret en Azure Vault`.

### Bad vs good examples

```text
MAL:  fix: arreglo bug
BIEN: fix(forms): corregir validación de CUIT en PersonaJuridica (aceptaba 10 dígitos)

MAL:  update readme
BIEN: docs(readme): agregar sección de setup local con connection strings de ejemplo

MAL:  trigger rebuild
BIEN: chore(ci): re-trigger pipeline tras rotación del permiso de la CI en Key Vault
```

---

## Rebuild before commit — NEVER commit code that does not compile

**Mandatory rule: Modify → Build → Test → Commit.** In that order, always.

### .NET backends (FRESNO, Ebano, Totora, Pacara)

```bash
dotnet build                        # 0 errores obligatorio
dotnet test --filter "<TestScope>"  # tests de la feature (scoped)
# La suite completa no va en cada commit a dev: corre en el portón de /tycon-merge-to-main,
# cuando el dev la pide o al cierre del Step 4 del pipeline. Ver test-execution-discipline.md.
```

### Angular/TS frontends (calden-tablero, FRESNOBZExtForms)

```bash
npm run type-check                  # obligatorio antes de push a main
npm run build:dev                   # verificar que el bundle se genera
# Si pasa → commit. Si falla → arreglar antes de commitear.
```

### Hard rule

- If `build` fails → **DO NOT commit** — fix it first.
- If tests fail → **DO NOT commit** — fix them or exclude them with an explicit justification.
- If you already committed something that does not compile (e.g. you merged without building first), the fix is a **new commit** that repairs it, not an amend.

---

## Merges to main — use the `/tycon-merge-to-main` skill

Merges to `main` are done with the `/tycon-merge-to-main` skill, not with `git merge dev` by hand: the skill generates the detailed changelog that the product pipeline can publish as a release note.

### Correct

```
Usuario: "llevalo a main"
Agente:  [invoca skill /tycon-merge-to-main]
```

### Incorrect

```
Usuario: "llevalo a main"
Agente:  git merge dev --no-edit                 ← mensaje genérico, no sirve como release note
Agente:  git merge dev -m "merge dev to main"    ← igual de inútil
```

### Why

- The skill runs `git log origin/main..dev --oneline` first and groups the changes by story/scope.
- A pipeline that publishes release notes takes the **merge commit message**. A `--no-edit` or a generic message leaves customers with no view of what changed.
- Always `--no-ff` (explicit merge commit) — no fast-forward.

### The branch is deleted when it goes in

A branch that is not deleted when its pull request goes in stays alive forever: on 2026-11-01 there were 1,019 remote
branches already merged into `main` across the two harness repos.

- **Azure DevOps**: a pull request to `main` built by hand with auto-complete says explicitly whether it deletes the
  branch; the flags and the draft case are in `guides/integrations/ado-in-the-core.md`, §«Las convenciones de git». The
  pull request guard requires it; the merge skill already does it on its own.
- **GitHub** (a human task, once per repo, done by whoever administers the repo): turn on
  **«Automatically delete head branches»** in **Settings → General → Pull Requests**. There is no flag the harness can
  ask for there: the platform deletes it.

---

## Where a PIPELINE change goes, and the trap of measuring it wrong (2026-09-04)

**Nobody works directly on `main`.** A pipeline change is not the exception: it goes to `dev`
like everything else and reaches `main` through the promotion pull request each team already uses.

### Why not straight to `main`

A pipeline fix that **goes in through its own `ci/<qué-arregla>` branch straight to `main`** leaves
`dev` behind. The reason can be real —the fix has to be in the next build, and promoting `dev` drags
along other people's half-finished work—, but it is an exception for urgency, not
a rule.

**The bill** (measured: 24 direct fixes in three days left `dev` between 42 and 64 commits behind
`main`, and between 92% and 94% of that gap was those CI commits): the next
promotion of `dev` to `main` conflicts on `azure-pipelines.yml`, and a rushed resolution of that
conflict **reverts the fixes without anything turning red** — which is exactly the kind of silent
failure those fixes exist to close.

### 🔴 The trap: a branch that is behind is not a dead branch

Measuring `dev` against `main`, seeing dozens of commits of lag and concluding *"here the team works on
`main`"* is **false if the measurement is contaminated by whoever takes it**: the lag may have been
produced by that person's own recent work. The correct conclusion is the opposite —`dev` is the working
branch and it has to be brought up to date—; publishing the other one turns an exception of a few days into the
team's permanent rule.

It is the same kind of mistake as measuring the build queue from a listing that arrives late: **before
concluding anything from a number, check that you did not move it yourself**. If a branch looks abandoned, check
whose commits left it behind, and when they were made:

```bash
git log --format='%ad %an %s' --date=short origin/dev..origin/main | head -20
```

### What holds

- **A pipeline change goes to `dev`**, and to `main` through the team's promotion.
- **If it goes straight to `main` for urgency, `dev` is brought up to date in the same move.** Not doing it
  leaves a bomb in the next merge, and whoever defuses it badly does not notice.
- **One pull request per repo with ALL the pending changes**, not one per fix. Each pull request
  runs the whole pipeline again
  to test the same thing plus one line: with two lanes for the whole organization, six batches over
  five repos are the difference between twenty minutes and three hours.

## Bringing `dev` up to date

The startup notice `scripts/hooks/dev-behind-main-notice.js` says when `dev` is missing commits from `main`, and asks
the agent to offer the update. **Without a yes from the person, it is not done.** With the yes, in this order:

1. `git fetch origin` and count again: if it is already up to date, say so and stop.
2. The working tree clean, or stop and say so: nothing that belongs to someone else is saved in a stash.
3. `git switch dev && git pull --ff-only`.
4. `git merge --no-ff origin/main -m "chore: bajar main a dev (queda al día)"`. On a conflict, `git merge --abort` and
   tell the person: it is not resolved without them (the typical case is the version file).
5. `git push origin dev`. If a policy or a non-fast-forward rejects it, it is not forced: a `main → dev` pull request is
   offered instead.
6. Go back to the branch the person was on.

**Why it is not automated:** moving `origin/dev` while someone is working bounces their push and creates a conflict
with the version file for them. That merge no longer re-versions the forms: the change detector does not count merges
(`scripts/ci/forms-to-version.sh`). Bringing `dev` up to date does **not** take the work stuck in `dev` to `main`: that
is a merge to `main` with `/tycon-merge-to-main`, and the notice offers it separately.

## A pull request in conflict only because of the indexes or the signatures

Two stories in parallel each add their line to `specs/epics.md` and `specs/sprint-status.yaml`, and their signature to
`.tycon/runtime-waivers.jsonl`. The one that goes in second conflicts on those three files, and the pull request server
does not apply the `.gitattributes` union. That is what `node scripts/tools/catch-up-main.js --repo <dir> [--push]` is
for:

- it brings in `origin/main` with a merge and joins both sides of those three files. In the indexes there is one line
  per story (the branch's, if the branch changed it); in the signatures, all of them, once each and in time order;
- it commits the merge with a normal commit, with all the checks. With `--push` it pushes without forcing;
- if it conflicts on any other file, or a check rejects the commit, it undoes the merge and leaves the branch as it
  was.

The closing guard does not charge that merge for the stories that `main` brings in: what the index has identical to
the branch being brought in already went through its own pull request. What was resolved by hand is judged.

## What NOT to do — never, under any circumstances

### Forbidden flags

- `--no-verify` → skips pre-commit hooks. If a hook fails, **fix the cause**, do not dodge it.
- `--no-gpg-sign` → skips signing. Only if the user asks for it explicitly because of a setup problem.
- `--no-edit` on merges → produces a generic message, invisible as a release note.
- `-i` (interactive) on rebase/add → there is no interactive stdin in this session.

### Destructive operations

- `git push --force` to `main` or `master` → **never**, no exceptions. To `dev` or a feature branch only with the user's explicit consent.
- `git reset --hard` over unpushed changes → ask first, it can destroy work.
- Bulk `git checkout .` / `git restore .` → same rule.
- `git branch -D` → ask first.

### Amending pushed commits

- `git commit --amend` on a commit that was already pushed → **never**. It rewrites remote history and breaks other people's checkouts.
- If a pre-commit hook fails, the commit **DID NOT happen** — make a new commit with the fix, not `--amend` over the previous one.
- The simple rule: **always a new commit**, unless the user explicitly asks for an amend AND the commit is not pushed.

### Git config

- **NEVER** `git config --global` without an explicit request. Do not touch the user's `user.email`, `user.name`, signing keys or aliases.

---

## Selective staging — repos with a "dirty" working tree by default

Some team repos have, **permanently and on purpose**, a working
tree with dozens of modified / untracked files that are **NOT committed**. They are
local artifacts (installer output, auto-generated skills, caches). The commit is
ALWAYS **selective**: `git add` of the specific files you touched, never
`git add -A` / `git add .`.

### The skills clone on a machine in transition (`~/.claude/agent-skills` as a real folder)

The harness is **a single repo** (the skills live in `skills/` of the same clone), and using the
harness does not need a clone: on a machine installed without cloning, `~/.claude/agent-skills` is a link to
`~/.tycon/harness` and this section does not apply. It applies only to whoever MAINTAINS the harness from a clone and
still has the old skills clone as a real folder (the transition to a single repo). It is the most notable case. When
you run `git status` there you will **always** see:

- ~50 **modified** `skills/bmad-*/SKILL.md` files + `bmad-skill-manifest.yaml`.
- ~70 **untracked** folders: `skills/gds-*`, `skills/wds-*`, `skills/bmad-tea/`,
  `skills/bmad-testarch-*/`, `skills/super`, etc.

That is **expected noise** — the BMAD installer and other tools generate it when they run.
**It is NOT pending work to commit.** Ignore it.

🔴 **Rule**: when you commit to `AgentSkills`, `git add` ONLY the files
of the specific skill you changed (e.g. `git add skills/tycon-pipeline/SKILL.md
skills/tycon-pipeline/scripts/marker.js`). NEVER `git add -A` or `git add .` — you would take
the ~50 BMAD modifications + ~70 untracked folders into a giant commit that is not
yours and clutters the team's history.

If you are not sure what to include: `git status --porcelain` and pick by hand only what
belongs to the change the user asked for.

---

## Checklist before every commit

- [ ] Did the user explicitly ask for a commit? (If not → **stop**)
- [ ] Does `build` pass with 0 errors?
- [ ] Do the feature tests pass?
- [ ] If it is the merge to `main`: did the full suite pass in the `/tycon-merge-to-main` gate?
- [ ] Does the message describe WHAT + WHY? (not generic)
- [ ] Is `Co-Authored-By` separated by a blank line?
- [ ] Am I using a HEREDOC (not `-m "single line"`)?
- [ ] Am I adding specific files (not `git add -A`, which can pull in `.env` / secrets)?
- [ ] If it is the `AgentSkills` repo → am I ignoring the expected noise (modified `bmad-*` + untracked `gds-*`/`wds-*`) and committing only my files? (see "Selective staging")

If any answer is NO → fix it before running `git commit`.

## MANDATORY adversarial review for harness code (2026-08-23)

**Every CODE change in the harness or in `agent-skills` goes through an adversarial round
(`/code-review high`) BEFORE the push.** The only exemption: pure documentation — and watch out for the trap
in that exemption: a document that WORKS as configuration (the tool names table, the
bench cases, an `advisors.yaml`) counts as code here. When in doubt, review it.

**Measured**: two consecutive rounds on the
same work, both with confirmed findings that really broke things:
- The first, on a commit that was "already verified" (selftests and bench green): 12 confirmed, one
  DESTRUCTIVE.
- The second, on the FIXES from the first: 14 confirmed, TWO destructive again (both
  proven by running them), and **three findings broke rules that the first round had just written
  into the headers of those same files**.

The lesson behind the rule: mechanical verification (selftests, bench, cases with a prior
red) proves that the code does what its author had in mind — it does not find what the author did not think of.
And design rules get broken again while they are being written: knowing about the mistake does not
make you immune to repeating it. Fresh adversarial eyes are the only layer that has shown it
catches that kind of problem so far.

**Why the story pipeline does NOT need this**: it already has it — the Step 5 advisors and the
pipeline's adversarial pass are exactly this layer. The hole this rule closes is touching the
HARNESS outside the pipeline, which is how work is done in these two repos.

How it runs: the round runs in the background (6-8 min), the confirmed findings are applied before the
push, and non-trivial fixes deserve their own round (the evidence above: the fixes
from one round had their own destructive bugs).
