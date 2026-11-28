# Test execution discipline — don't melt the dev's machine

In Spanish: [test-execution-discipline.md](test-execution-discipline.md).

> **Golden rule:** during development, the agent runs **only the tests of the file(s) it touched**.
> The full suite runs **in the `/tycon-merge-to-main` gate, when the dev asks for it, or once
> at the close of Step 4 of the story pipeline** (`test-gate.sh`), **never twice in a row** and
> **never in parallel with a fan-out of subagents**.
>
> **In a repo that narrows the gate (`test_gate` in `.test-gate.yaml`, like the harness), the full suite never runs
> on the dev's machine**: `test-gate.sh` runs only the suites close to what changed, with a cap, and the full one is run
> by the pull request's CI.

## The problem

`vitest run` (and `dotnet test`, and plain `npm test`) **parallelize by default** using ~`cores-1`
workers/forks. Each vitest worker loads **jsdom + the full React module graph**. On a
typical team machine (**8 cores / 16 GB RAM**), running the **full suite** (hundreds of files,
1500+ tests) launches ~7 forks that together **exhaust the RAM → swap → thrash**. Diagnostic symptom:
vitest's `collect` shoots up to hundreds of seconds (e.g. **822s**) and the machine **freezes**.

It gets worse when, **at the same time**, the agent has **8–11 subagents (advisors) running in parallel**
(each one doing greps/reads). The full-suite + fan-out combination is what kills the machine.

## Behavior rules (the agent) — NON-NEGOTIABLE

1. **While iterating: only the touched file.**
   - Vitest/Jest: `npm test -- <patrón-del-archivo>` (e.g. `npm test -- ZonasResumen`).
   - .NET xUnit: `dotnet test --filter "FullyQualifiedName~<Clase>"` or `--filter "Name~<Test>"`.
   - **NEVER** `npm test` / `vitest run` / `dotnet test` **without scope** while iterating.

2. **The full suite: in the `/tycon-merge-to-main` gate, with the dev's OK, or inside the
   story pipeline.** Outside the pipeline, a commit to `dev` goes with the tests of the touched area: the
   merge gate re-runs the full suite as a blocking step, so running it earlier costs double. Inside the
   pipeline, the `test-gate.sh` run at the close of Step 4 is the authorized full run
   (the code rejects a green that does not
   come from `test-gate.sh`). Outside those cases, if it seems necessary, ask — especially if
   the dev is using the machine (bad example: two full suites, ~3500 tests, for a commit
   to `dev` with the scoped ones green). Not "to confirm" in the middle of the work, not two runs
   in a row; if it already ran and passed, it is not run again unless the diff has changed
   substantially since then.

   *Clarification (since 2026-08-28)*: "unless the diff has changed" is now
   decided by a mechanical check, not by eye — `suite-freshness.js check` compares the fingerprint of the code
   that the green run measured (stored in `tests-result.json → code_state`) against the current working
   tree. If the pipeline iterated fixes after the green of «Correr las pruebas» (Run the tests) and `suite-freshness` says STALE, the
   closing re-run (the last round of Revisores, when it converges) replaces the one from «Correr las pruebas» — a single one, never one per
   iteration: a green that describes code that no longer exists does not count as "already ran and passed". The
   `/tycon-merge-to-main` gate runs build + tests on the already-merged code (in .NET, without
   `Integration`/`EdgeCase`), or the pull request validation runs them on the server.

   *After a red, first repeat the suite that failed*: `bash …/test-gate.sh <repo> <story> --suite <ruta>` (the
   `ruta` from its entry in `suites.json`). While any of them has not come out green on its own, the full run exits 76 without
   launching anything and gives the command for each one.

   *Bringing in main does not repeat what was already measured*: with the gate narrowed because a CI runs the full suite, if what the
   last run measured, merged with main, gives exactly what is in the folder, only the suites that failed run, plus the ones
   that name files main brought in. The folder is compared, not the commits. Any other change runs the usual set
   (`lib/after-main.js`). It does not see an ignored file that a suite reads, nor the target of a link outside the repo: that is left
   for the pull request's CI. In the private repo's assembled tree the same holds, comparing each repo: the private one and the public one. If
   the team profile also changed, or the public repo came from somewhere else, the usual set runs.

   *A part that did not change keeps its green*: a story that touches two projects in the same repo (the backend and the site)
   runs each one separately. If a part already gave green in this story and branch, and nothing that can
   affect it changed, it does not run again. What can affect it is the part's folder, the repo's shared files, what git ignores
   (a `.env`, something generated), the gate, the versions of its tools and the variables that change a test
   (`lib/part-keep.js`). A browser part is never kept, nor one that names a path of the other part or outside
   the repo, nor a repo with workspaces. To run them all: `TYCON_TEST_GATE_ALL_PARTS=1`. The merge to main and the CI
   run everything.

   *The full suite does not run on the machine*: in a repo that narrows the gate, only the suites that read what was touched run, and
   at most 60 (the machine cap; the repo changes it with `test_gate.max_local_suites`). If there are more (a
   control file or a central piece named by hundreds was touched), the ones closest to the change run: the touched suite, the
   one named like the file, the one that names it by its path. The rest are deferred, with their reason, to the pull request's
   CI, and the close says so: «la suite completa la corre …, hasta el tope de 60» (the full suite is run by …, up to the cap of 60). The touched
   suites and the repeated ones that went stale always run.

   *Without a base nothing runs*: if it is not known what was touched, the gate exits 7 («sin acotar: la cubre la CI del pedido», not narrowed: the pull request's CI covers it) instead
   of running all the suites, and says how to give the base: `TYCON_COVERAGE_BASE="$(git merge-base origin/main HEAD)"`.

   *A large run waits its turn*: on a machine with a coordinator, from 100 suites to run upward, narrowed or not, they go one
   at a time. If another run has the turn, the gate exits 75 without running anything and says who has it.

3. **Never full-suite + subagent fan-out at the same time.** If advisors/subagents are running,
   **wait** for them to finish before launching the full suite (and vice versa). Sequence, do not overlap.

4. **Cap on parallel subagents.** Do not spawn 8–11 agents at once. Batch in groups of **≤4–5**
   or sequence. (The runtime already caps concurrency, but a large fan-out still adds I/O load.)

5. **Gate on the real exit code, NOT on piped output.** `npm test | tail` returns the exit of
   `tail` (0), masking the red. Capture `$?` from the command itself or read the real summary.

6. **Flakes that pass in isolation = do not re-confirm** by running the suite again. Run the file
   alone; if it passes in isolation, it is a load flake, it is documented, the whole set is not re-run.

7. **A suite that compares the FINGERPRINT of a generated artifact does not run while another process
   regenerates it.** `dashboard.test.sh` (C-27) hashes the dashboard page before and after
   to prove the suite does not touch it; if `dashboard.js` (which rewrites it) runs in parallel, the
   case comes out red with no defect at all, and ruling it out costs a second
   run. Same rule as «full suite and subagents do not overlap», extended
   to generated artifacts: first regenerate, then run the suite, never both at once.

8. **Only one run of each check per repo: `marker.js run-check` takes a lock, and the second one exits 75.** If
   a run of the same check is already in progress in the same repo, the second one launches nothing; the 75 is not a red: it says
   since what time the other one has been running, its pid and its session. `test-gate.sh` passes that 75 through as is, without `tests-result.json`. You wait for its
   result, you do not relaunch. The lock of a dead process is released on its own; it is not released by age. If it got stuck,
   the refusal names the lock folder so it can be removed by hand.

## The guard against unscoped tests: what it recognizes

The guard (`scripts/hooks/test-scope-guard-pre.sh`) reads the command the way the shell reads it (with `scripts/lib/test-scope.js`)
and stops the unscoped full suite even when it is not at the start:

- **behind a prefix**: `time`, `nice`, `nohup`, `timeout 60`, `env A=b`, `A=b`, `command`, `exec`, `sudo`, `!`,
  `xargs`, `watch`;
- **inside a grouping or control flow**: `( … )`, `{ …; }`, `if`, `for`, `while`, `case`, a function,
  an alias, `$( … )`;
- **launched by another program**: `bash -c`, `sh -c`, `eval`, `bash <<<`, `echo … | bash`, `ssh`, `docker exec`/`run`,
  `su -c`, `script -c`, `tmux`, `screen`, `find -exec` and, in PowerShell, `&`, `iex`, `pwsh -Command`, `cmd /c` and
  `Start-Process`;
- **through another manager or by its path**: `pnpm`, `yarn`, `bun test`, `npx -y`, `npm t`, `npm run test:*`,
  `uv`/`poetry`/`pipenv run`, `python -m pytest`, `py.test`, `node_modules/.bin/vitest`, `dotnet.exe`.

What counts as scope, per tool: a specific test file or test folder (not `.` or `./`), `--filter` of
`dotnet test` with a value, `-k` of `pytest` with a value, the pattern after `--` in `npm test`. What does **not** count: the value of
an option (`-o bin/out`, `--reporter verbose`, `--project web`), an empty filter, something only known at run time
(`pytest $X`), or a vitest or jest name filter (`-t`, `--grep`): those still load every file, in
parallel. What it cannot read (unclosed quotes, the text of a shell built from variables) is stopped, and the guard says so.

The `TYCON_FULL_SUITE=1` escape hatch works when it goes with the test command: as a prefix, with `env`, exported or with
`$env:` earlier in the same command. Mentioning it in some text (an `echo`, a commit message) does not use it.

## The harness suites: how many at once, which ones run and which are the slow ones

- **How many at once.** The gate (`test-gate.sh`) and the portable suites run `min(núcleos menos dos, núcleos menos la
  carga de 1 min)` (min of cores minus two, cores minus the 1-minute load) suites at once, never fewer than four (or cores minus two on a small machine). The load is measured
  before launching the first one: it is everyone else's. Two cores are left for the person, who keeps using the machine; with the
  machine idle the rest is used, and with the machine loaded the four of the floor keep running: one at a time, a gate of
  380 suites did not finish. Before launching each suite above the floor it looks again: with the load over double
  the cores, it waits for another one to finish. A gate of 100 suites or more that starts with fewer than three at once says so in
  its first line, with the estimated finish time, and notifies the coordinator while it runs. `TYCON_SUITES_MAX_WORKERS` (gate) and `TYCON_PORTABLE_PARALLEL` (portable) override the
  rule; in CI the gate runs half the cores and the portable suites run 4. The startup line says the number and
  where it came from: «8 a la vez (10 núcleos, carga 1.2 al arrancar)» (8 at once, 10 cores, load 1.2 at start).
- **Which ones run.** A gate run by hand, without this repo's pipeline run, narrows from the
  fork point with main (`origin/HEAD`, `origin/main` or `main`): the suites that read what the branch changed run,
  including what is already committed. Without a main branch it does not narrow and says so. The line «acotado a lo tocado: N archivos desde <sha> (<fuente>):
  corren M de T» (narrowed to what was touched: N files since <sha> (<source>): M of T run) says how many and why.
- **Which ones are slow.** Each run leaves the seconds of each suite in the machine's log
  (`suite-times.jsonl`, in the state folder). `node scripts/tools/suite-times.js slow` lists the 20 slowest by
  the median of their latest measurements, with their trend; `--max-load <c>` keeps only the runs with the machine
  quiet, and `runs` lists the runs. Before splitting a suite or sending it to the nightly run, it is worth looking at where its
  time goes: almost always it is repeated work in the test itself (one process per file to take a fingerprint, the same
  git query for each imported module), and cutting it does not change what it tests.
- **How long each one may take.** Each suite has a cap: five times the longest it took on this machine, according to that
  log, between 10 and 60 minutes; with no measurement, 60. The one that goes over it is cut with all its processes and counts as red, with
  the line «❌ cortada por tiempo: pasó su tope de N min (de dónde salió)» (cut for time: went over its N-minute cap (where it came from)). A process that left its group stays
  alive, but the run goes on. Its time is not recorded, so once it hangs its next cap does not go up. On 23/11, a guard-record test, which takes under half a minute, hung
  for hours in a temporary tree, with the machine out of processes. `TYCON_SUITE_MAX_SECONDS` sets the cap for all of them; with `0`
  there is no cap.

## The durable technical fix (per project)

Behavior discipline is not enough (a human dev, or a future agent, can run the full suite
anyway). **Cap the workers in the config** so the full suite **never** saturates, even
when it is run whole:

### Vitest (`vitest.config.ts`)

```ts
export default defineConfig({
  // ...
  test: {
    // Cap de workers — evita exhaust de RAM/CPU al correr la suite completa.
    // '50%' = mitad de los cores (4 en una máquina de 8). Override en CI con VITEST_MAX_WORKERS
    // (los runners de CI suelen tener más RAM y se benefician de más paralelismo).
    maxWorkers: process.env.VITEST_MAX_WORKERS ?? '50%',
    minWorkers: 1,
    // ...resto de la config
  },
});
```

- On machines with little RAM relative to the number of cores (typical: 16 GB / 8 cores with jsdom), `'50%'` is the
  balance. If it still thrashes, drop to a fixed number (`maxWorkers: 3`) or `'40%'`.
- **Nuclear alternative** (very heavy suites or CI with little RAM): `fileParallelism: false` (runs the
  files in series inside one worker) — slower but minimal RAM.

### Vitest — beyond the cap: attack the COST, not just the parallelism (measured: 2.7x)

The cap prevents the freeze but does not shorten the suite. Measured: out of ~330s of wall time the tests were only
97s — the rest was `collect` (768s: each file re-evaluates the whole module graph) and
`environment` (244s: one jsdom per file). Diagnosis: look at the breakdown vitest prints in
`Duration (transform … collect … tests … environment …)`. If `collect >> tests`, the problem is
the heavy barrels, not your tests. Validated fix (one suite 330s→120s, another 39s→15s, 1719/1719 green):

```ts
test: {
  // Workers thread (más livianos que forks → menos RAM → menos riesgo de swap thrash):
  pool: 'threads',
  // Pre-bundlear UNA vez los barrels gigantes que cada archivo re-evaluaba módulo a módulo
  // (lucide-react solo ya son ~1500 módulos):
  deps: { optimizer: { web: { enabled: true, include: ['lucide-react', '<otros barrels pesados>'] } } },
}
```

**Ruled out WITH evidence — do not retry blindly:**
- `isolate: false` (the most aggressive lever, files in ms): if the suite uses per-file `vi.mock`
  (the norm in React), sharing the module registry between files breaks massively (~800 reds in
  the measured suite). Only viable by re-architecting the mocks (DI instead of `vi.mock`).
- Global `clearMocks`/`restoreMocks`/`unstub*` as "hygiene": they destroy the `vi.spyOn` from
  `beforeAll` → components render empty (`<body/>`) → massive false reds with the symptom
  "Unable to find element".
- Next lever if more is needed: `environmentMatchGlobs` to run stores/services/utils
  in `node` (without jsdom), and fake timers in the slow files that wait for real timers.

**Observability gotcha**: NEVER validate a long run
piped to `tail`/`head` — it leaves you blind until the end. Always `> /tmp/run.log 2>&1` and read the log.

### .NET (`dotnet test`)

`dotnet test` parallelizes **per assembly** (not per test inside the assembly, except with `[Collection]`/
xUnit parallelization). The risk is lower, but for large suites:

- Always filter while iterating: `dotnet test --filter "FullyQualifiedName~<Clase>"`.
- If there are several test projects, avoid `dotnet test` on the whole solution while iterating;
  point at the specific `.csproj`: `dotnet test tests/<Proj>.Tests/<Proj>.Tests.csproj --filter ...`.
- To limit xUnit parallelism: `xunit.runner.json` with `"maxParallelThreads": 2` or
  `"parallelizeAssembly": false`.

## The mutant check: narrowed tests, never the suite

When «Correr las pruebas» (Run the tests) closes, the mutant check breaks the new code on purpose and runs **only the tests that
the story declares**, once per mutant, on a copy of the repo. Never the whole suite: if it cannot narrow, it exits
«estructural» (structural) and runs nothing.

- **Which recipes mutate:** Jest and Vitest (with the package's binary, `node_modules/.bin/…`), .NET (`dotnet test` with the
  closest test `.csproj` and a filter by class), pytest and `node --test`. It mutates JavaScript/TypeScript, C# and
  Python. The recipe is chosen from the package structure, never by reading a test.
- **Bash suites:** if all the tests the story declares are `*.test.sh`, it runs each one with `bash <suite>`;
  a mutant dies if the suite exits with something other than 0. It does not mutate bash: a `.sh` declared as code is left out, with its
  reason. Mixing bash suites with tests from another recipe exits «estructural».
- **Only the story's tests:** with `node --test`, if each test file carries the story's `@story-<id>` mark,
  each run passes only the tests with that mark (the id is anchored: one story's mark does not match another's whose number starts the same way).
  If a file does not carry it, the whole file runs and the check says so. A filtered run that runs no test is «no
  medido» (not measured), not green.
- **An organization recipe** (`stack.test_runners`) mutates if it declares `scoped`: the command that runs only some
  tests, with `{files}` (the files) or `{classes}` (the .NET classes). Without `scoped`, the check exits
  «estructural» and says so.
- **When it blocks:** only if no mutant died (the tests do not exercise the new code). With `node --test` it always
  blocks. With the other recipes it warns and lets it through until 2026-11-18, so that each team can add the missing
  tests; from that day on it blocks too. The bash recipe has its own date: it warns until 2026-11-30. The
  survivors only warn, with any recipe.
- **The caps:** with each suite's time measured on the machine (the gate's time log), each run
  gets the measured time plus half (with a ceiling of 10 min) and the total is that times (1 + mutants) (with a ceiling of 20 min); with
  several suites, the slowest one rules. With no measurement for some of them, the usual ones: .NET, 8 min in total and 3 min per run
  (it recompiles for each mutant); the others, 3 min in total and 2 min per run. Those are also the floor for the
  measured ones. No run goes past what is left of the total; the gate kills it at 22 min as a safety net. Before the base
  it prints how many mutants there are and how long it may take; a base that goes over its cap exits «no medido» with the cap and the
  measured time.
- **The copy** does not link `bin/` or `obj/`: .NET compiles in the copy, never in the dev's repo.

## Suites that simulate the dev's machine: the test home folder

A suite that installs, triggers checks or makes toy commits writes records in
`~/.claude/.tycon-pipeline/` (and `frenos.jsonl` goes up to the mailbox and feeds the dashboard). Run with the real HOME,
those records are false and get mixed with the dev's; and a `git commit` with the real HOME reads the dev's global
`core.hooksPath` and runs **their** hooks. Reason: without a shared piece, each suite builds
its fake HOME by hand and in its own way, and some end up dirtying the real logs.

- Every new bash suite of that kind uses `scripts/tests/lib/fake-home.sh` (with `source`):
  `fake_home_create <dir> [--installer]` builds the fake HOME (and pins the harness and agent-skills to what
  the real one resolved to); it can be called once per case, or inside a subshell so it does not leak out of there.
- The check is **positive evidence**: `fake_home_count <registro> <texto>` counts what was left in the fake
  HOME. Never «the real log did not grow»: the dev's sessions write there at the same time.
- In `node --test`, the same by hand: a temporary HOME BEFORE the `require` calls (some paths are fixed when
  the module loads) and restored in `test.after`, with a positive assertion on the temporary one.
- The lab folder is protected with `scripts/tests/lib/lab-guard.js`: in bash,
  `node "$RAIZ/scripts/tests/lib/lab-guard.js" "$BASE" <suite> || exit 1`; in `node --test`,
  `labGuard(BASE, '<suite>')`. It stops if the folder falls inside a harness clone, in agent-skills or in `.claude`, and takes
  the name of the place from `place.js`. Reason: copied by hand from an old suite, the guard had the name of the
  internal repo written in it, and the check on published content only stopped it at the pull request. `harness-place.test.js` stops the copy.

## A test does not depend on a sha or a time

A test that comes out red now and then almost never has a bug in what it measures: it has a piece of data that changes on every
run. Reason: a random red blocks pull requests that did not cause it and teaches people to retry instead of reading.

- **Lab commits**: with fixed date, author and committer (`GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE`), so the
  sha always comes out the same. A sha built with the run's time has, for example, an eight-character prefix
  made only of digits roughly 2 times out of 100.
- **Git's automatic maintenance, turned off** in every lab that does `commit`, `fetch`, `push` or `merge`
  (`-c maintenance.auto=false -c gc.auto=0`, or `harness_lab_git` / `harness_lab_no_auto_maintenance` from
  `scripts/tests/lib/harness-lab.sh`). Since git 2.55 it keeps running in the background after the command returned and
  touches the lab's `.git` (`objects/maintenance.lock`, `info/refs`) while the test takes its fingerprint.
- **The clock**: the date is injected with the variable of the program under test (`TYCON_TODAY`, `TYCON_…_NOW`). If the
  test reads the clock for something else (measuring how long it takes, naming a temporary file), it says so in a comment
  `stable-data: <motivo>`.
- **What is searched for**, apart from the changing data: a short number searched for in output that carries a time with
  milliseconds or a sha finds it there now and then. Search for the number on its own, in its field.
- **A single snapshot**: if the test compares a fingerprint and then lists what changed, both come from the same
  walk; otherwise, a red can come out without saying what changed.

`scripts/tests/stable-test-data.test.js` stops NEW tests that create commits without fixed dates or without turning off
maintenance, or that read the clock without injecting it or declaring it. Dates and maintenance are searched for in the code,
not in comments. The `stable-data: <motivo>` declaration only counts when written in a comment, and exempts the file from
both rules: it is for the file that needs dates that change on purpose (a test of ordering by date) or that
names the patterns in its texts, like the check itself. The ones that already existed are in
`scripts/tests/fixtures/stable-test-data-baseline.json`, a list that can only shrink. The check looks at the text
and does not execute: it does not see a sha or a time that arrives another way (a file written by another script, the `git log` of
someone else's repo), nor the commit of a function that wraps git and is called without any option (`g "$R" commit`). Nor
does it tell apart a comment at the end of a line or a quoted string that names `GIT_AUTHOR_DATE` from a date that is
really fixed, and it takes as a comment a line of a multi-line text that starts with `//` or `*`. There, this rule
is what counts.

## Quick checklist before running tests

- Am I iterating? → **only the touched file**, with a filter.
- Am I going to run the full suite? → in a repo that narrows the gate (`test_gate`), **no**: the pull request's CI runs it.
  In the others: is it the `/tycon-merge-to-main` gate, the pipeline's `test-gate.sh`
  or did the dev ask for it? If not → **no**. Did I already run it on this diff, or are there subagents
  running? If yes to either → **no**.
- Does the project have a `maxWorkers` cap in the config? → if not, **add it** (it is the durable fix).
