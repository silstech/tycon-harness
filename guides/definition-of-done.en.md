# Definition of Done — status transition gates

In Spanish: [definition-of-done.md](definition-of-done.md).

**Applies to ALL TYCON stories.** It defines mandatory gates for two transitions:
- `in-progress` → `review` (the **dev's** gate: implementation closed WITHOUT open deferrals)
- `review` → `done` (the **QA/UAT** gate: runtime smoke check + end-to-end verification)

Green build + green tests are **NOT enough**. Two ways a `review` story is broken without anything flagging it:
1. With a green build, green tests and approved advisors, a backend endpoint silently returns HTTP 400, because the E2E tests skip when the endpoint does not answer 200 (the `skip-on-not-ok` pattern).
2. With `TODO(Story-X-deferral)` documented in its own code: the wiring stays deferred and nobody closes the loop. Only when doing a dry-run of the demo do you find out that the pieces do not exist.

The detail of each one is at the end (§ Why Gate 2, § Why Gate 1).

---

## Gate 1 — `in-progress` → `review` (the dev's responsibility)

**Absolute rule: a story CANNOT move to `review` if it has open deferrals of its own.**

Patterns the validator detects as open deferrals:
- `TODO(Story-{N}-deferral)` (recommended, canonical)
- `// TODO: Story {N}` / `// FIXME: Story {N}` / `// HACK: Story {N}`
- `[DEF-{N}-...]` / `DEFERRED-{N}` in code or comments
- References to the story itself with a pending verb: `pendiente Story {N}`, `Story {N} deferred`, etc.

If the implementation leaves work pending, there are 3 valid paths (marking `review` is NOT allowed):

| Situation | Correct path |
|-----------|-----------------|
| The pending work is needed for some AT/AC the story declares | Status stays `in-progress` until it is closed. It does NOT move to `review`. |
| The work is legitimately out of scope (discovered during implementation) | Create a separate story (e.g. `1.7.1`) with `depends_on: [1.7]` and status `backlog`. Document the cut in the original story's Change Log. |
| The work depends on another story in this sprint or the next | Mark the deferral with an explicit cross-ref to the story that closes it. It does **not** stay as a generic TODO. |

**Explicit anti-pattern**:
```typescript
// TODO(Story-{N}-deferral): wire useSignalR(...).on('scan.validated', ...)
// Diferido por D3 (Story {N}). Requiere también el código que dispara los scans.
```
→ If this is in the code and story {N} is in `review` → CRITICAL violation. The story never really left `in-progress`.

**Validator automation**: the `tycon-story-validator` agent (rule `VAL-C5`) scans the files the story modified/created looking for these patterns. If it finds any → it blocks the pipeline's commit prep (Step 5).

### Stories delivered in batches — the `pipelines:` block in the frontmatter

When a story is large and delivered in several batches (backend / frontend / sub-features), it **CANNOT** be marked `review` with pending batches that are "implicit in the dev's head". There are two valid options:

1. **Status stays `in-progress`** until all the batches are done.
2. **Status can move to `review` per completed batch** IF AND ONLY IF the frontmatter includes a `pipelines:` block that documents, in machine-readable form, which batch was covered and which one is pending with its concrete `blocked_by`. See `story-format.md` §1.1 for the full schema.

```yaml
pipelines:
  - name: A-backend
    status: done
    acs: [1, 2, 3, 4, 5, 6]
    tasks: [1, 2, 3, 4]
    tasks_partial:
      - id: 5
        done: [5.1, 5.2, 5.3, 5.4]
        pending: [5.5]
  - name: C-frontend-listado
    status: blocked
    blocked_by: "Story <N.M> Task 5.5 backend — endpoint GET /api/ceibo/pedidos/{id}/listado no mergeado"
    acs_pending: [7, 9, 10]
    tests_pending: ["T36", "T39", "T40"]
```

**Block rules**:

- Each `blocked` pipeline requires a concrete, non-empty `blocked_by` (`tycon-story-validator` rule **VAL-C6** fails CRITICAL if it is missing).
- Every AC in `## Acceptance Criteria` must be assigned to some pipeline (covered or pending) — an orphan AC = `tycon-story-validator` rule **VAL-W7** WARNING.
- Each `acs_pending` / `tasks_pending` / `tests_pending` must be traceable in `tasks/todo.md` (a `[DEF-{N.M}-...]` line) **OR** in an engram observation `type=decision` with keyword `Story {N.M}`. If it is in neither → `tycon-deferral-tracker` rule **DEFTR-C1** CRITICAL blocks commit prep.
- Skipped tests (`it.skip`, `[Fact(Skip=...)]`, etc.) in the diff's code require an adjacent comment `TODO(Story-{N}-deferral: AC#X | Task y.z | blocker: ...)` — without the comment → `tycon-deferral-tracker` rule **DEFTR-C2** CRITICAL.

### Why the `pipelines:` block

A backend batch can merge covering 5 of 6 declared endpoints. If the sixth is not documented as blocked anywhere machine-readable —only a "PENDING in future sessions" paragraph in the story's Change Log—, you only find out that the data source does not exist when you implement the frontend batch.

**Root cause**: validating "TODO in code" (VAL-C5) does not see a "subtask declared in the spec and not delivered". Without the block, the loop between spec and diff is not closed.

**Fix**: the `pipelines:` block + the `tycon-deferral-tracker` advisor (immediate CRITICAL) + rules VAL-W7 / VAL-C6 / DEFTR-C1 / DEFTR-C2 (2026-05-12).

---

## Gate 2 — `review` → `done` (the QA/UAT responsibility)

Mandatory checklist before marking `done`:

### 1. Runtime smoke check of endpoints

For each endpoint the story declares or touches:

```bash
# Levantar la stack real (NO mocks)
./scripts/devhost.sh start            # backend on :5001
./start-all.sh                        # dev-proxy on :8082 + frontend ports
```

**Check that the 3 ports are listening** before going on (a
proxy:8082 that is down gives `Failed to fetch` in the dev panel
even if backend:5001 and frontend:8090 are OK):

```bash
for port in 5001 8082 8090; do
  curl -s -o /dev/null -w "$port: HTTP %{http_code}\n" --max-time 3 \
    "http://localhost:$port/$([ $port = 5001 ] && echo 'api/health' \
     || [ $port = 8082 ] && echo 'api/ceibo/health' \
     || echo 'dev.html')"
done
# Esperado: 3x HTTP 200. Si alguno responde 000/timeout → reiniciar ese servicio.
```

Then:
- **Backend**: run an explicit `curl` against each endpoint with realistic auth. Check for the expected HTTP 200/201 (NOT 400/500). If the story declares 4xx handling, check that the `error.code` is the expected one.
- **Frontend**: open the dev panel (`dev.html` or equivalent) and check that each endpoint's health-check buttons answer OK.

**⚠️ URL per environment** — BEFORE building the curl, work out the target: the same route can change shape between the local environment and staging/prod. A 404 against staging with a route that works locally is almost always a badly built URL, not the endpoint. The shape for each stack is given by its pack's guide (for the Bizuit plugin stack, the `bizuit-plugin-dotnet.md` guide of the bizuit pack, §7).

Example:

```bash
# Bug: TenantId="default" en appsettings causa 400 INVALID_TENANT
SINCE=$(date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ")
curl -s -o /tmp/r -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer laboratorio" \
  "http://localhost:5001/api/auditoria/events?since=$SINCE"
# Esperado: HTTP 200 {"events":[],...}
# Si HTTP 400: BUG → fix → re-verify → recién entonces pasar a `done`
```

**A criterion with a number is measured.** If the criterion says «responds in under 2 s», it carries the mark
`@measure(duration < 2s)` (`story-format.md` §5) and its smoke run through `smoke-run.sh` records how long the command took
(`duration_ms`). What the command measures itself, it prints at the end of its output with
`TYCON_MEASURE <nombre>=<valor><unidad>` (for example, the p95 of 100 requests); the matrix compares it against the
criterion's bound, and outside it the criterion does not come out green.

What that promises and what it does not: it is **one run, in one environment** (that of the machine that ran the smoke, which goes in its
provenance). It is not a load test and says nothing about production, and the CI server does not see it: the server
gate only checks that the files exist. A `TYCON_MEASURE` value is what the command says: the harness guarantees
that it was not edited after the run (it confirms this against the home mirror), not that the number is an honest
measurement. `duration_ms` is taken by the harness itself, with the wall clock around the command.

### 1.bis. Runtime smoke of failure paths (mandatory when the story has fallback/retry/circuit)

**Rule 2026-05-13**: when the story declares resilience behavior (PDF fallback, retry with backoff, circuit breaker, timeout handler, partial success envelope, discriminated union response with N statuses), the smoke check is NOT complete with the happy path alone. It MUST include **at least 1 runtime reproduction of each failure scenario declared in the `### Errores` / `### Edge cases` ACs**.

Why: "the happy path is verified" leaves the resilience path as dead code. A story can declare a `fallback-pdf` AC and another for `fallback-pdf-memory` + base64 auto-download, and the component can ignore the envelope's `response.status`. That bug is only detected by doing a manual smoke with the printer-mock down (a realistic production scenario with the printer unreachable). Without this explicit check, the in-memory PDF is lost without alerting the user.

**How to verify:**

```bash
# Por cada failure scenario del AC, reproducir manualmente:

# 1. AC dice "si printer no responde, fallback PDF" → matar la printer/mock:
kill $(lsof -ti:9100)   # tira printer-mock
# → Trigger el flow desde UI o curl. Verificar que el response trae
#   el status declarado (e.g. 'fallback-pdf-memory') Y que el frontend
#   muestra el UX declarado (toast warning + auto-download).

# 2. AC dice "si filesystem unwritable, in-memory PDF" → mockar el path:
# mount -o remount,ro /var/ceibo/pdf-fallback/   # u otra técnica
# → Trigger + verificar response status + UX.

# 3. AC dice "timeout 5s" → simular delay > 5s en el mock:
# (editar mock para sleep 6s antes de ACK)
# → Trigger + verificar TimeoutException atrapada + fallback path activado.
```

**Anti-pattern**: "I tested it with everything up and it worked" → you are verifying the happy path only. If the AC lists 4 statuses, the smoke must cover all 4 (or at least the ones != 'ok').

### 1.ter. Verify without deploying: the SQL dumped by the compiled code, against a real read-only database (accepted pattern, 2026-09-06)

When the
«official» smoke requires a deployed staging (merge + deploy) and the defect is in SQL or in a query, the
runtime verification can be closed **before** the merge like this:

1. The development connection string (`appsettings.Development.json`) points to a **real read-only**
   database or to a replica; never to one with write access.
2. A **temporary test, which is not committed**, calls the compiled methods that build the query
   (`BuildQuerySql`, `BuildCountSql`, …) and dumps the real SQL to a file.
3. The smoke runs **that** SQL against the real data — not a hand transcription, which can
   drift from the code.
4. 🔴 Necessary condition: the smoke has to be shown **red by reverting the fix**, reproducing
   the symptom; otherwise it is decoration.
5. The evidence (the dumped SQL, the output before and after, the red with the fix reverted) goes to
   `.advisors/dod-runtime/<story>-smoke-evidencia-<ts>.md`, like any other smoke.

It does not replace the staging smoke when the story touches more than the query: it brings it forward.

### 1.quater. A migration that DELETES is tested on a disposable database, or by warning the owner first (2026-09-14)

A migration that deletes data (`DELETE`, `TRUNCATE`, `DROP`, a
cleanup of versions or records) is validated **only** in one of these two ways:

1. **A disposable or own database**: a local container, a copy restored for the test, or
   a database that belongs only to the project and to nobody else.
2. **A shared database, with prior notice to its owner**: you tell them what it will delete and against which database,
   and it is run **after** their OK. Without an answer it is not run.

A test database used by another project **is not disposable** even if it is called «test». And «validating
the fix» does not change the rule: what is deleted during validation is deleted all the same.

Why: validating the fix for a cleanup migration against another
project's test database, without warning, deletes their data (measured: 7 plugin versions, 497 configuration
options and 1.4 million records).

### 2. E2E with fail-loud env vars

If the story has E2E tests that depend on an endpoint:

- The specs **MUST NOT use the `skip-on-not-ok` pattern without a fail-loud override**. Convention: env var `<DOMAIN>_REQUIRED=1` (e.g. `E2E_AUDIT_REQUIRED=1`) that makes the probe helper **throw an error** instead of returning a skip message.
- Run at least once with that env var set **before moving to `done`**:

```bash
E2E_AUDIT_REQUIRED=1 npm run test:e2e
# Si los tests skipean: hay un bug oculto → investigar
# Si los tests fallan: hay un bug real → fix → re-run
# Si los tests pasan: gate cumplido
```

- The **dedicated CI** that brings up the whole stack MUST set that env var. Skipping silently in CI (when the infra is available) is unacceptable — it hides bugs until production.

### 2.bis. A screen AC is proven with an image from the real browser

What the customer sees is not taken as proven because a test came out green: a **screen AC** requires a **screenshot or a
recording** from the real browser, tied to that AC. Without it, the runtime verification matrix leaves it as `SIN-EVIDENCIA`
(no evidence; it blocks and cannot be waived), even if the E2E or the smoke came out green.

- **What a screen AC is**: in a story that wires UI, every AC except the one that carries `@sin-pantalla` in its text;
  in a story without UI, only the one that carries `@pantalla`. When in doubt, it is a screen AC. Backend stays with smoke and measurement.
  If the screen belongs only to a `blocked` batch (and no active criterion is a screen one), the close does not ask for its browser
  proof or its review until the batch stops being blocked; the guide for the backend criteria, it does.
  If the commit (or the run) changes a screen file, the exemption is not granted and the close says so in one line.
- **With the E2E**: put `@ac-N` in the title of the test that opens the screen (`'la lista muestra el total @ac-2'`). The E2E
  gate with the filter of the story's specs saves the screenshot, and the `captures.json` in its folder ties it to the AC. A
  Playwright `.webm` recording counts the same as a screenshot.
- **With a smoke**: `smoke-run.sh <evidence-dir> <ruta-de-la-story.md> --acs N --pass-if '…' --capture <archivo.png|.webm>
  -- <comando>`. The image's fingerprint stays in the log and in the mirror; changing it afterwards takes it out of the count.
- **Lab data**: the image is from a lab or test site, with invented data; never from a customer's real
  data.
- **Compatibility**: the rule applies to stories that start after it is published; one that was already in progress gets
  a warning in the matrix, with no red.

### 3. Cross-check with dependent stories

- If Story X declares `depends_on: [Y]` and Y is in `review`/`done`, verify at runtime that Y's artifacts still work (do not assume).
- If Y exports an endpoint, X should exercise it in its tests **without** the silent skip pattern (see §2).

### 4. Documenting known drift

If during the smoke check you detect drift between what the story declares and the runtime reality (e.g. schema rename, outdated endpoint URL, testid drift):

- Do **NOT** mark the story `done`.
- Create an engram entry of type `learning` or `bugfix` with a cross-ref to the fix commit.
- Reference it in the story's changelog.

### 5. Gate 1 closed (deferrals)

Re-confirm that Gate 1 still holds: the story's code has no open `TODO(Story-{N}-deferral)`. If new TODOs that reference the story itself appeared during the QA cycle, it does **not** move to `done` until they are closed or moved to a separate story.

---

## Explicit anti-patterns

### ❌ "Green build, I merge to main"

A build only verifies compile + unit tests. It does NOT verify:
- that the endpoint answers 200 with real auth
- that the SQL queries run against the deployed schema
- that the SignalR broadcasts reach the client
- that the dev panel works end-to-end

### ❌ "The test passed, it's OK"

If the test uses `if (!res.ok()) test.skip(...)`, **the test can pass by skipping**, not by real verification. TYCON convention: **skip-on-not-ok only locally without infra; in dedicated CI it must be fail-loud**.

### ❌ "I already tested it on my machine"

Not enough. Test it in the CI environment (which is where the E2E tests run) or document the difference (e.g. environment variables, seed data).

### ❌ Marking `review` → `done` in bulk at the end of the sprint

Each story must pass its own gate. If three stories are all in `review` and get marked `done` on the last day, the odds that all of them passed the smoke check are low.

---

## Why Gate 2 — "green" tests that are actually skipping

**Symptom**: the `dev.html` dev panel reports HTTP 400 errors on endpoints of stories that are in `review` with green tests.

**Root cause** (example): the DevHost's `appsettings*.json` sets `System:TenantId="default"` (a string that cannot be parsed to `int`). An endpoint that does `int.TryParse(userContext.TenantId, out var tid)` → fails → 400.

**How it hides**:
- A spec with `if (!res.ok()) test.skip(true, 'Audit endpoint unavailable')` → **skips silently on a 400**.
- A probe helper (`probeAuditEndpoint()`) that also skips on !ok.
- CI runs with "green" tests when in fact they are skipping because of a broken backend.

**How it is detected**: by opening `dev.html` by hand after implementation. The red toasts expose it.

**Fix**: correct the configuration, and have the E2E pipeline export `E2E_AUDIT_REQUIRED=1` for fail-loud.

**Lesson**: apply this DoD checklist BEFORE marking `review`→`done`, not after the bug hits production.

---

## Why Gate 1 — `review` with open deferrals

**Symptom**: the dry-run of a demo finds that key UI pieces of the script do not exist at runtime: some not implemented, others not wired.

**Root cause**: the stories are marked `review` with green commits, approved advisors, passing tests — **BUT** the code itself has:

```typescript
TODO(Story-{N}-deferral): wire useSignalR(signalrService).on('scan.validated', ...)
Diferido por D3 (Story {N}). Requiere también el código que dispara los scans
(form/simulator/hardware), no presente todavía.
```

→ The TODO explicitly declares that part of the story's scope is pending. The story is in `review` even with open deferrals.

**How it hides**:
- Sprint accounting ("9/9 review") looks only at the `status:` frontmatter, NOT at the TODOs in code.
- The deferrals stay in `tasks/todo.md` (`[DEF-{N}-...]`) — invisible to the sprint dashboard.
- The tests cover the visual feedback via Storybook, NOT the real keyboard → API → store flow.
- Without `VAL-C5`, the validator does not check for `TODO(Story-X-deferral)` in code.

**How it is detected**: a dry-run of the demo block by block, before showing it to the customer.

**Fix**:
- Process: an explicit Gate 1 in this guide.
- Automation: the `VAL-C5` rule in `tycon-story-validator`, which scans TODOs and blocks commit prep.

**Lesson**: `review` means "implementation closed **without** pending work from the story's own dev". If you have deferrals → `in-progress` or create a separate story. **There is no intermediate "review-but-with-pending-stuff" state**.

---

## How to integrate into the TYCON pipeline

The `tycon-pipeline` skill ends at `step-11-prepare-commit` with the commit made but the story still in `review`. However, two checks ARE automated in the pipeline:

1. **Gate 1 (open deferrals)** — `tycon-story-validator` rule `VAL-C5`. Step 5 of the pipeline re-runs the validator after implementation with the deferral check flag; if it finds `Story-{N}-deferral` TODOs in modified files, it returns CRITICAL and blocks commit prep. **This prevents marking review with open deferrals**.

2. **Gate 2 (runtime smoke check)** — manual, by QA/UAT, after the pipeline. The `review` → `done` transition stays outside the pipeline's automatic scope.

### The evidence of a story that already went into `main`

A story closes with the code it went into `main` with, not with today's `main`: if it went in identical to what was tested, the merges
of other stories do not force the test to be repeated. The entry is recognized on the first-parent line of `origin/main`: what was
tested is compared with the last commit before the evidence and, if it was not identical, with the first later commit that changed the
file. Whatever those merges break is reported by the nightly run, without reopening the story. If the story itself changed its
code, its tests or what they load after testing, the evidence expires. In signatures and guards the criterion also needs a
nightly test; elsewhere, without one, the risk stays written in «Aceptado sin cobertura posterior» (Accepted without later coverage). A merge with no known story
does not expire and is named in the notice. Who each merge belongs to is told by its branch, its commits and `<clave>-pedidos.jsonl`, an
editable log. The detail: `guides/accov-governance-protocol.md`, §7.

### The trimmed close (2026-09-16)

In the pipeline's «Probar en vivo» (Test live) step, what **blocks** is mechanical and it stayed: the per-AC matrix (each criterion
with a real run, or declared impossible and signed by the dev), the project's E2E gate, the
evidence hooks (`on-frontmatter-write`, `on-pre-commit`, `on-dod-evidence-guard`, `on-stop-dod-gate`)
and the CI gate. What **went away** is whatever re-read that same evidence with a model:

- **`tycon-dod-runtime-checker` is opt-in by surface.** It is decided by
  `pipeline.js dod-checker-needed --story <spec> --repo <repo>` (exit 0 invokes it, 3 does not), with three questions
  about the **only things it alone covers**: a worker (`BackgroundService`/`IHostedService`) in the diff, a
  complex transaction declared in the ACs (rollback or compensation verified at runtime), or a batch
  of the `pipelines:` block still in flight. If the helper cannot look (broken diff, no base, unreadable
  story), it is invoked. The decision stays in `gates.log` (`dod-checker-decision`).
- **The ACCOV-C9 meta-audit was retired** and **the ACCOV-C8 self-audit is optional** (if it exists incomplete,
  it warns; if it exists, the C10 convergence still applies).
- **Step 9** (close in Azure DevOps) no longer relaunches reviewers: `pipeline.js deferrals-open` answers
  whether live `[story-N-*]` tags or open batches remain.
- **The merge** does not launch the full E2E suite in the background: it comes back when the project gate has
  per-worker isolation.

How to measure whether it is enough: the dashboard card «Los hooks del cierre» (The closing hooks, question 4) counts, across all
machines, how many decisions of those hooks rejected a piece of evidence. If it drops to zero while the matrix's
`NOT-RUN` count goes up, the trim is reviewed.

Operational recommendation:
- When running `tycon-pipeline`, the Step 5 validator fails if there are open deferrals → forcing the dev to close them or move them to a separate story.
- When moving status `review` → `done` (by hand or via script), run the checklist of §1, §2, §3, §5 (re-confirm Gate 1 closed).
- Document the checklist result in the story's `Dev Agent Record > Completion Notes List`.

---

## One-liner summary

> **`review` requires ZERO open deferrals of the story itself.** If you have `TODO(Story-X-deferral)` in code that story X itself created, status stays `in-progress` or the work moves to a separate story (`X.1`).
>
> **`done` requires a real runtime smoke check**: `curl` (or equivalent) against each endpoint the story touches, against a real DevHost, with auth, and the expected HTTP verified. A green build is not enough.
