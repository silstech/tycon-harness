# safety-guard — the TYCON harness's handbrake

In Spanish: [safety-guard.md](safety-guard.md).

A `PreToolUse` hook with matcher `Bash|PowerShell` (the PowerShell tool is how Claude Code runs commands on Windows; with `Bash` alone the brake did not fire there, 2026-10-04) that **blocks irreversible destructive commands** before they run. **On by default** — opt out with `TYCON_SAFETY_GUARD=0`. Inspired by [ECC safety-guard](https://github.com/affaan-m/ECC/blob/main/skills/safety-guard/SKILL.md) but adapted to the TYCON stack (.NET, SQL Server, monorepos, multi-tenant, Bizuit host).

**Why:**
- Without a cross-repo destructive gate, nothing stops an irreversible command before it runs.
- The classic `--no-verify` bypass to skip pre-commit (`git-commit-conventions.md` forbids it, but a written rule is not enforcement).
- An accidental DROP DATABASE on a client's development database (`acmebase_dev`) would be catastrophic.

## When to turn it on

- Yes: autonomous sessions (`tycon-pipeline --autonomous`), work on production repos, a dev new to the team who has not calibrated their finger yet.
- Yes for senior devs too: the cost of having the brake on is ~0 (few false positives, a 1-line override); the cost of NOT having it and deleting a repo is hours.
- No: if your workflow includes intentional destructive scripting (clearing caches with `rm -rf`, bootstrap scripts with `curl|bash`). In that case, keep it off or use the session override.

## Turning it on

**It is on by default.** If your harness is up to date and your `~/.claude/settings.json` has the `SessionStart` hook that runs `install-tycon-hooks.sh` (TYCON standard), the brake installs itself in the next session.

To force it now (without waiting for the next `SessionStart`):

```bash
cd ~/.claude/tycon-harness && git pull
bash scripts/install-tycon-hooks.sh
```

Expected output:
```
✓ tycon: instalé 1 hook(s) en ~/.claude/settings.json
  + PreToolUse (matcher='Bash|PowerShell') → @tcg:safety-guard-pre.sh  [TYCON safety-guard: ...]
```

**Restart Claude Code** (the current session already has the hooks cached — it does not pick up the change until you restart).

To check that the script itself works:

```bash
echo '{"tool_input":{"command":"rm -rf /"},"cwd":"/tmp"}' | \
  bash ~/.claude/tycon-harness/scripts/hooks/safety-guard-pre.sh
```

It should print `🛑 TYCON safety-guard BLOCK [FS-C2]` and exit code 2.

## Turning it off (opt-out)

Set `TYCON_SAFETY_GUARD=0` in your shell config (`~/.zshrc` or `~/.bashrc`) and run the installer:

```bash
echo 'export TYCON_SAFETY_GUARD=0' >> ~/.zshrc
source ~/.zshrc
bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh
```

The installer detects the explicit `=0` and **removes the hook**:

```
✓ tycon: removí 1 hook(s) (motivo en línea)
  - PreToolUse → @tcg:safety-guard-pre.sh  [disabled by env var]
```

**Turning it back on later**: remove the line from `.zshrc` (or set it to `1`), `source`, and run the installer. It installs it again.

## Denylist v1 — what it blocks

Each rule has a stable rule ID (quoted in the block message).

| Rule ID | Pattern | Why |
|---|---|---|
| **FS-C1** | `sudo rm ...` | sudo rm cannot be undone + points to a misdiagnosed permission issue |
| **FS-C2** | `rm -rf /` and variants | Deletes the whole filesystem |
| **FS-C3** | `rm -rf ~` / `rm -rf $HOME` | Deletes your ssh keys, .zshrc, unpushed repos |
| **FS-C4** | `rm -rf .` / `rm -rf ..` | Deletes the cwd (usually a whole repo) |
| **FS-C5** | `chmod -R 777` / `chmod 777 /` | Opens all permissions — a workaround for a real permission issue |
| **GIT-C1** | `git push --force` / `-f` to `main`/`master`/`dev`/`release/*` | Rewrites shared history |
| **GIT-C2** | `--no-verify` on `commit`/`push`/`merge`/`rebase` (also with git options before the subcommand: `git -C <ruta> commit …`), `git commit -n`, and `core.hooksPath` pointed at another folder for that command (`-c`, `--config-env`, `GIT_CONFIG_*`) | Skips hooks (pre-commit, formatters, security) |
| **GIT-C3** | `git clean -fdx` | Deletes gitignored files (.env, local builds, secrets) |
| **GIT-C4** | `git add -A` / `--all` / `.` in `~/.claude/agent-skills` or in the tree the installed skills come from (the one `~/.claude/skills` resolves to), standing there or naming that folder in the same command with `cd <dir>` or `git -C <dir>` | Stages everything foreign that lives in that tree. If it cannot look at the tree (a dangling link, a folder without permission) it does not stop: it says so and exits 1 |
| **GIT-C5** | Merging while skipping the queue and main's CI, or loosening the branch policies: `gh pr merge … --admin`; a `gh api` call that writes a merge (`pulls/<n>/merge`, `merges`, `mergePullRequest`, `mergeBranch`), moves a branch (`git/refs/heads/<rama>` with PATCH, `updateRef`), a rule (`rulesets`) or a branch's protection; `az repos pr update\|create --bypass-policy` set to true; `az repos policy … create\|update\|delete` (creating a policy with its type —approvers, build, merge strategy, file size, letter case, reviewers, comments, linked work items— or a new GitHub ruleset hardens the branch and does not ask for a signature; changing or deleting a ruleset asks for one, with a box that says it replaces it entirely or deletes it, and what the command sends); `az devops security permission update` with bits 128, 32768, 2048 or 8192; `az rest` or `az devops invoke` writing to pull requests, policies or permissions. `scripts/lib/ci-bypass.js` reads it | The agent's account may be an administrator: without this brake, the CI and the checks' record stop being the second key. It asks for the `merge-bypass` signature (`escape:merge-bypass`, level 3) in the window or, without a window, with a click or an «aprobado» ("approved"): it is valid for that command, once, and never by delegation (in Codex, through the terminal). What the reader does not fully understand stops without a window: hidden (`bash -c`, `eval`, `$(…)`, a variable, `xargs`, `find -exec`, a body that cannot be read), launched by a program that is not a known wrapper (`arch`, `flock`, `sudo -E`), or with a word the shell builds where the form may go; if the reader does not load, it stops. Reading and the normal path (`gh pr merge <n> --merge`) pass. A direct push to main of the public harness is stopped by the publishing brake, with no way out for the agent |
| **GIT-C6** | `git reset --hard`, `git stash` (also `push`, `save`, `-u`), `git stash clear` and `git stash drop` without saying which one, when the working copy has uncommitted changes or the stack has something. A clean working copy, an empty stack and `git stash push -- <archivos>`, which hides only what it names, pass | Deletes or hides uncommitted work that may belong to another session or to the person; the `stash` stack is shared by all the repo's working copies |
| **GIT-C7** | Queuing or merging a GitHub pull request from someone outside the team (its author is not in the profile's `pull_requests.team_authors`): the pull request merge through its command, `enqueuePullRequest`, `enablePullRequestAutoMerge`, `mergePullRequest`, `pulls/<n>/merge`. It asks for the owner's signature; if it does not know whose pull request it is (no network, a built-up number, a broken profile), it stops | Code from someone outside would get into main without the owner seeing it |
| **SUP-C1** | `curl ... \| bash` / `wget ... \| sh` | Runs remote code without an audit — supply chain attack |
| **SUP-C2** | `eval $(curl ...)` | Worse variant: runs in the current shell |
| **PUB-C1** | `npm publish` | Accidental publish to the public registry |
| **PUB-C2** | `yarn publish` | Same as npm |
| **PUB-C3** | `dotnet nuget push` | Only CI should push to the NuGet feed |
| **SQL-C1** | `DROP DATABASE`, in upper or lower case and with comments between the two words (a plain `grep` that searches for the text does not stop) | You lose schema + data + history |
| **SQL-C2** | Inline `DROP TABLE` (not in `.sql`) | Schema changes go through a numbered migration |
| **SEC-C1** | `cat ~/.ssh/...` / `cat .../aws/credentials` | Secrets into the LLM's context |
| **SEC-C2** | `cat .env` / `cat .env.*` | Secrets into the LLM's context |
| **CMD-C1** | A command that carries a `\r` (carriage return); in PowerShell, also `\f`, `\v`, the non-breaking space, NEL or a Unicode space | Bash reads the `\r` as a letter and PowerShell as a line break: with it, part of the command is hidden from the brake. A command typed by hand does not carry it. It also stops if the character is inside a quoted text (a commit message with a non-breaking space pasted from a web page, a heredoc with Windows line breaks): the brake cannot know whether the quotes are real. The test-scope brake and the memory notice apply the same rule: with this brake off, a `\r` is still stopped |
| **ESC-C1** | `TYCON_NEW_NAMES` assigned anywhere in the command, with any value except `=1` (also `export`, `declare`, `printf -v`, the name split with quotes, or `$env:` in PowerShell); `TYCON_TEST_GATE` or `DOD_BYPASS` assigned with any value except `0` or empty (exact name: `TYCON_TEST_GATE_PART` is not it) | The first one turns off, at commit time, the real-names brake. `TYCON_PROD_LINT=0` no longer turns off the production catalog review: its way out is the `--commit` emergency, valid for the next commit in that repo, once and for 30 minutes. `test-gate.sh` sets `TYCON_TEST_GATE` inside its own process: written by the agent, it gives a test green (or a «sin medir», "not measured") that did not run; `DOD_BYPASS` closes a step without the evidence of the live test. `TYCON_NO_DEEP_REVIEW` is not checked: it is a request to skip the adversarial pass, and the pass is skipped only with the `adversarial-skip` signature. The person signs it (below). Naming them without assigning does not stop; a text that carries the assignment does (like GIT-C2) |
| **ESC-C3** | `marker.js set-autonomous <valor que lo apaga>` with autonomous mode on; `marker.js clear`, `clear-session` of the session itself or `update-story-status <h> review\|done` with a check in red, steps not run or the adversarial pass not closed; `marker.js set-check … --force-manual` or `pipeline.js check-count … --trust-ran` with the run in green or in red; an `--env-file` before `pipeline.js start` or `deep-review-gate` or before `marker.js mark-adversarial-skipped`, always, also before the run exists (it may carry a variable that changes the pass's decision; `--no-deep-review` alone is a request and does not stop); `marker.js clear-session <sesión> --lost` or `marker.js restore <sesión>`, always (below, «The lost run»). The files that follow `--files` are not the flag, except a lone variable with no known value or one whose value is a flag | They turn off the loop that does not let a run close with tests in red, or they archive as finished a run that did not finish. The normal way out for a story that could not be done is `marker.js close-as-debt`; doing it anyway is the person's decision (below). The normal close of step 11, `adhoc clear`, `doing clear` and a text that only names the command do not stop |
| **ESC-C4** | `marker.js close-as-debt` or `marker.js expect-red`, with a run in the session | They leave a way out foreseen by the story as the end of the run, or a check in red as expected. The person authorizes it, always (below); a text that only names the command does not stop. `expect-red acmatrix` asks for its own signature (`escape:rojo-esperado-de-la-matriz`), with the criteria and the date in view |
| **ESC-C5** | A command that creates, touches or copies an `ALLOW_DOD_EVIDENCE_WRITE` file (`touch`, `cp`, `mv`, a redirection, `tee`, an interpreter, `New-Item`, `Set-Content`, …), or that writes `dod_runtime_exempt: true` or `advisors_exempt: true` into a `.md` (`sed -i`, `perl -i`, `>`, `>>`, `tee`) | The permission to write by hand the evidence of the live test, the exemption from that test and the reviewers' exemption are signed by the person, with `marker.js sign-file <firma> <archivo>`, and the write comes afterwards with Edit or Write: through the shell it always stops. Looking at it, searching for it, deleting it or removing the exemption does not stop. Through the file-writing tool, two pieces watch it: the evidence guard (it consumes the permission only with the record of that signature, from the same session and on that file, within 30 minutes) and the header hook (it asks for the same signature to add the exemption to a story in implementation) |
| **ESC-C6** | `marker.js complete-step approve-plan` (or `3`) with `--approved "<cita>"` or `--mockup-approved "<cita>"`, or `approve-mockup --approved`, when it cannot be asked for in the window (the hidden form, Codex, another shell) | Approving the plan belongs to the person: they give it in the permission window; where the window does not reach, with a click in the options box or a typed «aprobado»; or in their terminal. The quote is not looked up in the conversation. By delegation the coordinator gives it only with the «aprobado» of the automatic review she launched, and never for a sensitive story. Without `--approved` the brake does not step in: a routine plan is approved only with the «aprobado» of the session's own review, which the script checks (`plan_review.routine_approval`) |
| **ESC-C7** | A command that runs `run-base-controls.sh approve` (approve a change to the repo's checks, or re-sign them after pulling main) that cannot be asked for in the window: hidden behind another command or inside a `bash -c`, an `eval` or a `"$(…)"`, in Codex, or launched from another shell; also with `--relayed-by`, which no longer signs. A `grep`, a `cat` or a commit message that names those words do not run it and pass | The owner signs a change to a check, in the permission window or in their terminal with the `pending` command. The coordinator signs it from her tab only if the team profile delegates it to her. A command that hides the signature (`node -e`, another script) does not ask for it, and `approve` does not sign |
| **ESC-C2** | A command that names `~/.claude/projects` (also after a `cd`) and carries a way of writing: redirection (except to `/dev/null`), `tee`, `sponge`, `sed -i`, `awk -i`, `dd`, `truncate`, `cp`, `mv`, an interpreter with code on the line; in PowerShell `Add-Content`, `Set-Content`, `Out-File`, `Copy-Item`, `Move-Item` | The saved conversations are the source of the validator's record and of the plan the person saw. Reading with `tail`, `grep`, `ls` or `wc` does not stop |

**What it does NOT block (on purpose):**

- `git reset --hard` — common for discarding uncommitted local changes.
- `git checkout -- file` / `git restore file` — selective, recovery is possible.
- `kubectl delete` / `docker system prune` — TYCON is not heavy on infra; add it if an incident comes up.
- `rm -rf <path>` with an explicit path (e.g. `rm -rf bin obj node_modules`) — legitimate use.
- `git push --force-with-lease` to branches that are NOT `main`/`master`/`dev`/`release/*` — rebasing your own feature branch is valid.
- Reading `.env` through `grep`/`awk`/`sed` — the block is only on `cat`/`less`/`more`/`head`/`tail` (the typical "let's see what's in here" modes). Automated workflows that extract a specific key with `grep` keep working.

## The deny rules: what stops even with hooks turned off

This brake is a hook: if someone turns hooks off, or the hook does not run, it stops nothing. For the catastrophic
cases, the installer also adds `permissions.deny` rules to `~/.claude/settings.json`, which Claude Code applies before
launching any hook and which no hook can let through. The list is `RULES` in `scripts/setup/harness/deny-permissions.js`:

| Rule | What it denies | Why it never needs an emergency |
|---|---|---|
| FS-C2 | `rm -rf /` and its option variants | No task asks to delete the whole disk |
| FS-C3 | `rm -rf ~`, `~/`, `$HOME`, `$HOME/` and their variants | No task asks to delete the whole home folder; something inside is named (`~/.cache/x`) and it does not stop it |

A deny rule does not have the emergency way out described below: it always stops. That is why two cases stay only in
this brake, with its emergency: `curl | bash` (Claude Code splits the command at the `|`, and the rule would have to stop
`bash` alone) and deleting a whole database (SQL-C1: it is authorized to recreate a development database, and it goes
inside a SQL client with no fixed form). This brake still stops the two in the table, with the same id: it is the second
net, and the only one in Cursor, which has nothing similar.

Codex does not read `permissions.deny`, but it has its own rules. With the Codex side on, the harness writes the same
ones for it, from the same list, in a file of its own: `~/.codex/rules/harness-deny.rules` (`build/deploy-codex-rules.js`).
It does not touch `default.rules`, where Codex records what the person approves, and it does not overwrite a file with
that name that does not belong to the harness.

The installer adds them in the full profile, without touching the rules each person already had; uninstalling removes
only its own (in Codex, its file). `TYCON_NO_DENY_RULES=1` does not add them, and in Codex it removes the harness's file.

## When a brake cannot decide in time

The rule: a brake that could not decide in time does not let the command through. Today two of the twelve shell brakes
follow it; the other ten have no clock of their own and, if they hang, Claude Code cuts them when the tool's limit runs
out and the command runs. The production brake is separate, in the managed configuration: it has its own clock, and if
its hook fails the command does not run ([producción con permiso](production-with-permission.md), production with
permission).

| Brake | Own clock | If it hangs |
|---|---|---|
| `on-pre-commit.js` | No | Passes at 600 s |
| `pr-one-per-repo-guard.js` | No | Passes at 600 s |
| `pr-auto-complete-guard.js` | No | Passes at 600 s |
| `session-cap-guard.js` | No | Passes at 600 s |
| `public-push-guard.js` | No | Passes at 600 s |
| `on-bash-write-gate.js` | 20 s (`TYCON_BASH_GATE_TIMEOUT_S`, from 1 to 50) | Stops and asks to retry |
| `safety-guard-pre.sh` | 20 s (`TYCON_SAFETY_TIMEOUT_S`, from 1 to 50) | Stops and asks to retry |
| `test-scope-guard-pre.sh` | No | Passes at 600 s |
| `engram-pre-commit.sh` | No | Passes at 600 s |
| `session-collision-guard.js` | No | Passes at 600 s |
| `background-question-guard.js` | No | Passes at 600 s |
| `on-bash-write-after.js` | No | Passes at 600 s, without a snapshot: in the recording mode it is recorded; with undo on, it stops the session |

Each brake has a proposed class: **requirement** (it protects something that cannot be undone or that does not belong to
the agent: production and data, secrets, the shared branch and what is public, the owner's signatures, the stories and
the records; it is not turned off for any model) or **preference** (a routine step or a style that a model could decide
well on its own). It is a proposal until the owner signs it, check by check, and it does not change what the brake
decides. It lives, with its reason and its review date, in `scripts/metrics/controls-classification.json`; how much each
one stopped, by model, is shown by `scripts/metrics/controls-table.js`. The pipeline checks that stop (a `marker.js` or
`pipeline.js` command that refuses) also have their class, marked `del_pipeline`.

What the clock does not cover: if a brake is killed from outside, or does not start, the command passes. These hooks get
no `onFailure` on purpose: they live in the user's folder, and a half-done update would leave every session on the
machine without a shell. In `on-bash-write-gate.js`, on Windows or with a Node without `process.execve`, an analysis
stuck in a system call is not cut either: it passes at 600 s. A program the analysis launched can keep running after the
brake stopped.

**What is slow and what is cut is recorded in `hook-errors.log`, on its own.** If `safety-guard-pre.sh` or
`on-bash-write-gate.js` take half their clock or more, they write a «LENTO» ("slow") line, with how long they took,
their limit and the step that ate the time (for example, «la ventana de permiso (su última nota: confirmando el click en
la conversación de la sesión…)»: the note is the last one the step left, not necessarily the one that took long). If the
clock cuts them, the «FRENÓ POR FALLA» ("stopped by failure") line says which step they were in. So when a brake is slow
on another machine, the data is in its log without having to reproduce it. «LENTO» does not count as a failure, neither
in the startup notice nor in the checks table. In the command brake, seconds are whole numbers, and slow starts at 2 s
even if the clock is shorter.

**When `safety-guard-pre.sh` is cut by its clock, the slow step is measured.** With `TYCON_SAFETY_TRACE=1` (in the `env`
of `settings.json`, or in the terminal the tool is opened from) the brake writes to `safety-guard-times.jsonl`, in the
loose-logs folder, one line for each node it launches (and what those launch): when it started and how long it took. It
also records its own total on exit. A node that did not finish because the clock cut it leaves only its start: that one
ate the time. It records the script and its subcommand, never the command's values, and it does not change any decision.
With a path instead of `1`, it writes there.

**The check before the window uses only the time the brake has left.** Before opening the permission window for a
signature, the script checks whether it would deny it: that way the «Sí» ("Yes") is not lost on a command that was going
to fail. That check waits up to 12 s, but on a loaded machine what runs before it had already spent part of the 20 s, and
the brake's clock cut the command without opening the window. Now the brake passes the window the second at which its
clock cuts it, and the check ends 3 s before that. If not even one second is left, it does not run. In both cases the
window opens anyway and the owner still gives the signature: the script checks everything again when signing, so nothing
is lost.

## Skipping the brake: the person decides

Each skip is a signature by the person, with its command; the full list is in
[the owner's signatures](owner-signatures.en.md). No phrase opens a rule of this brake: that is what the emergency is
for. For the other signatures, where the window does not reach, the «aprobado» the person types is valid: a hook records
it when the message is sent. A task handed over, another session or Telegram do not sign. There are four ways, and the
agent cannot use any of them alone:

**The emergency: the only way out of a rule of this brake.** When the brake stops, it saves the exact text it read as a
numbered request, and the banner shows the number. The person signs it in their terminal, never through the window or by
delegation, with their reason and that number:

```bash
node ~/.claude/tycon-harness/scripts/setup/harness.js sign emergency --reason "<por qué>" --request <número>
```

The terminal shows what is being signed (the reason and the command) and asks «¿Firmás? (s/n)» ("Do you sign? (y/n)"):
it signs with `s`, `si` or `sí`, and any other answer is «no», also `y` or `yes`. On Windows there is no terminal that
can be read: the command opens in a new window and there you type the three random words it shows. Nobody retypes the
command: its quotes and backslashes do not arrive the same from PowerShell, cmd or bash. It leaves a single-use
permission that expires in 30 minutes; the agent repeats the command as it is and the brake lets it through once. Any
other text, even if it differs by a space, is still stopped. The number also expires in 30 minutes, and a used or expired
one does not work. The signature goes into the shared signatures log, with who gave it and why. `TYCON_SAFETY_OFF=1`, in
the environment or before the command, no longer turns anything off: the banner says so. The agent does not run
`harness.js sign`: this brake stops it, also if it opens a terminal of its own.

**In the permission window (Claude Code)**, the other signatures. The agent runs the signature's command in its exact
form, alone: `marker.js close-as-debt …`, `marker.js sign-file dod_runtime_exempt <archivo>`. The brake does not let it
run on its own: it asks the tool for the permission window, with the text of what is being approved. With «Sí» the
command runs; with «No», it does not. For a script's signatures (approving the plan, exempting a critical finding, the
signatures on a file) the brake first leaves a record of the request, and the script signs only if the process tree shows
that the tool's shell launched it with that exact command. The record is valid only once and expires in 30 minutes. A
signature on a file leaves a record that the next Edit or Write of that session on that file consumes.

**With a click or an «aprobado» (Claude Code)**, where the window does not reach: a tab that does not ask for
permissions, a background session or Windows, where the window does not sign and only counts through the Bash shell
([En Windows](owner-signatures.md#en-windows), On Windows). The brake denies the command and tells the agent what to
show: the options box with a single question, or the same text in the chat, with «firma <id>». With the person's click or
«aprobado», the agent repeats the command. It is valid once and expires in 30 minutes. The rules are in
[Aprobar sin terminal](owner-signatures.md#aprobar-sin-terminal) (Approving without a terminal). `TYCON_SAFETY_OFF`,
`TYCON_PROD_LINT`, the emergency and skipping the adversarial pass do not accept it.

**In the person's terminal**, where there is no brake: the command in the «Firmarla en la terminal» ("Sign it in the
terminal") column of that list (almost always the same one with `--terminal`). It is the only way in Codex, which has no
permission window, and the way for what does not accept the click. It is also the way for every signature the brake
cannot decide: the command hidden behind another one (`cd … && <firma>`), the tool launched by another tool or by its
shell, a live background shell, or on Windows the PowerShell shell and the shell forms that are not the measured one. On
Windows, an escape that no script checks is also signed there: one of a variable, or one of `marker.js` that only the
brake looks at, such as closing the run. One that its script checks (`set-check --force-manual`, `check-count --trust-ran`,
`sign-file`) is signed like a script's signatures: with the click or the «aprobado», run alone and in its
exact form (without a pipe after it such as `2>&1 | tail`). Each brake's banner carries the terminal command. On Windows,
signing by box or by «aprobado» works only from Git's Bash shell: from the PowerShell shell the brake offers neither the
window, nor the box, nor the «aprobado», but Git's Bash shell or the terminal, with a single command for the three shells
(`node "<ruta>/marker.js" … --terminal --for-session <sesión>`; details in
[En Windows](owner-signatures.md#en-windows), On Windows).

The signatures and escapes that the team profile sets as routine (`approvals.delegated_signing`) are given by the harness
on its own, without a window (`guides/owner-signatures.md`, «Las firmas de trámite las da el arnés», "The harness gives
the routine signatures"); the escape's record carries the route `automatica`. Those that belong only to the owner
(`approvals.owner_only`) are always signed by a person. Each escape's record notes the session and the escape's name.
Closing as debt (`ESC-C4`) leaves the run with `cierre: deuda` and the debt, and it goes on to the commit. The matrix's
expected red (`marker.js expect-red acmatrix --tests <T1,T2> --until
<AAAA-MM-DD>`, also `ESC-C4`) carries to the commit
the criteria without live evidence that the list covers, until the date (at most 14 days from the close as debt). Its
window shows those criteria with their text, the tests and the date, and its record notes the fingerprint of that list
and that date: `marker.js` accepts it only for the same list and date, once. With a wrapped command or one in a variable,
what is being signed cannot be seen, and the window does not open. A run closed this way is left with `cierre: abortada`,
its reason and who authorized it (`marker.js clear` reads it from the escapes log); without that line, `via: sin-registro`.
`ESC-C3` reads the command the way the terminal reads it: it counts every call to `marker.js` (or `marker`, ignoring case)
that is not an argument of a program that only reads or shows text (`grep`, `rg`, `echo`, `cat`, `sed`, `git`…). So two
calls on different lines count, as do `$(…)`, the Windows path with backslashes, the session id in a variable, prefixes
with their options (`nice -n 5`, `timeout -s KILL 5`) and wrappers (`bash -c`, `eval`, `cmd /c`, `find -exec`, `iex`,
`Start-Process`, a text that goes to `| sh`, a heredoc that goes to a shell); a comment, a heredoc that goes to a file or
a commit message that names `marker.js clear` do not stop. What is doubtful stops like closing: a subcommand or an id
that cannot be seen (`$VAR`, `xargs`), `clear-session` without an id, an unclosed quote or a command that could not be
read. Names are read without quotes or backslashes: `pipe''line.js` or `mar''ker.js` are the scripts, as for the shell,
and a backslash with a line break is joined. If the command runs `node` with a script whose name cannot be read
(`pipelin?.js`, `pipe[l]ine.js`, `mar$'k'er.js`, a variable), it is read as either of the two scripts; such a script run
directly, without `node`, is not seen. With the folder in a variable and the name written out (`node $S/a.js`,
`node "${D}/x.js"`), the script is that one: the shell does not change the last part. It is read as hidden if the shell
can split the variable into words (without quotes, with a value the command does not show or with spaces), or if the path
carries a `$(…)`. If the brake cannot read the command (the harness's interpreter is missing, `run-close.js` is missing or
the reader crashes), a command that names `marker` or `pipeline` stops: without the interpreter those scripts do not work
either, so stopping costs nothing. `ESC-C1` also stops an assignment with the **name built** in another variable
(`V=TYCON_…; export $V=1`, `declare -x "$V=1"`, `env "$V=1"`, `printf -v "$V"`) in a command that runs `marker`,
`pipeline` or `test-gate.sh`: the name cannot be seen, and the way is to write it out in full so its rule decides.
Outside the pipeline, building names does not stop. What does not assign does not count: the name of a program that
starts like one of those commands (`readability` is not `read`), some code braces in quotes, or an arithmetic `$((…))`
that computes (`$((L-60))`); arithmetic that assigns (`$(( $V = 1 ))`) does stop.

**The code of `node -e` is not a script.** With `-e`, `-p`, `-pe`, `--eval` or `--print`, node runs no file: what follows
are arguments of the code, and it passes (`node -e '<código>' "$a" "$b"`, `C="$c" node -e '…process.env.C…'`). A
`marker.js` or a `pipeline.js` written in the same command is read the same way, word by word
(`node -e '…' && node pipeline.js check-count --trust-ran` stops), also among the code's arguments and built by the shell
with the name in view (`node -e '…' pipelin?.js check-count --trust-ran`, `$(echo …/marker.js) clear`). What the code
builds by itself is not read: neither the pipeline's name nor the flag hidden in its arguments, in variables, in the body
of a heredoc or in a text. It is not needed either: turning off the pass requires the record the owner signs, and without
it the pipeline runs it anyway, however the flag is written. Notes written through a heredoc that name the pipeline with
the flag pass.

What it does not see: the `marker.js` file name built in a variable, a `node -e` that loads it or that runs another
program with what it receives, `node` in a variable or in a substitution (`N=node; $N -e '…'`), another interpreter
(`python3 -c '…os.system(…)…'`), a copy with another name, or a text program that also executes (`awk` with `system`).
Through those, without the brake seeing it (also with the script in a variable among the code's arguments,
`node -e '…' "$M" clear`), a `marker.js clear`, `set-autonomous false`, `update-story-status … done`, `close-as-debt`,
`set-check … --force-manual` or a `check-count --trust-ran` can run. The pass is not exposed: the signed record protects
it. For the rest there is still the autonomous mode loop, which does not let the turn close with a check in red, and the
dump's `cierre`: `marker.js set` does not write it, does not overwrite the checks (`checks`, `checksProvenance`), the pass
or the autonomous mode of the same story, does not empty its pending steps, and when moving to another story it leaves the
previous one recorded as aborted if it had not finished.

Why: the agent can write the prefix. A model stopped by `--no-verify` rewrote the command with `TYCON_SAFETY_OFF=1` on
its own and committed, even though the instruction said not to look for another way. A phrase quoted from the
conversation was not enough either: the agent wrote it there through other paths. That is why the brake has a single way
out, the emergency, signed in the terminal for one command, and there is no way to turn it off for a whole session. The
«aprobado» of the other signatures is something else: a hook records it when the message is sent, and it is checked that
the person typed it.

Each escape is recorded in `~/.claude/.tycon-pipeline/frenos.jsonl`, with the rule skipped and the route (`ventana`,
`delegacion` with the session that signed, or `persona` for the emergency), without the command's text. Writing a
turn-off into `.zshrc` is stopped by `HARNESS-C1`. Removing a check from the tool's configuration (`disableAllHooks`, a
switch in `env`, a harness hook) is stopped by `HARNESS-C2`, through the terminal and through the editing tools.

**Codex** has no permission window: the emergency is the same, in the terminal.

`harness.js sign` signs any id in the catalog, always in the terminal: that way the agent cannot fill the signatures log
with signatures nobody gave. Only the emergency has an effect: the other signatures are approved as this section
describes.

Known limit: the emergency's permission is a file in the account's state folder. The write brakes protect that whole
folder, with Edit, Write and through the shell, just like the permission window's records
(`scripts/tests/harness-sign.test.js`, T14). An agent that managed to write it without going through them would give
itself the permission: it is the same limit those records have. Closing it requires a separate process with another
owner, which is left for later.

`escape:TYCON_SAFETY_OFF` and `escape:TYCON_PROD_LINT` remain in the signatures catalog, marked as retired: they no
longer turn anything off, nothing asks for them anymore, and their row in [the owner's signatures](owner-signatures.en.md)
gives the emergency as the way out. They stay there because without them a team profile that names them in
`approvals.owner_only` would read as broken; removing them requires migrating that profile.

### The story's status and the marker

When the brake denies closing a run in red, an agent may look for another path: writing the story's status by hand and
deleting the marker. The pipeline's hooks stop that, with any tool:

- **A story written through the shell.** A command that writes a story that is not a draft (redirection, `sed
  -i`, `tee`, `cp`, a `node -e` or a `python3 -c`) stops with «HISTORIA ESCRITA POR CONSOLA» ("story written through
  the shell"). From a command you cannot see what ends up written. Instead: the editing tool, and for the status
  `marker.js update-story-status <historia> <estado>`. When all the editors in the command's position are a `sed`
  that names its files as they are (without wildcards, braces, `$(…)` or a variable the command does not define, and
  with a script that does not read, write or run anything else: without `r`, `w`, `e` or the `w` and `e` flags), the
  editor writes only those files: each `cd`'s folder is where they are read from, and the command's other words do not
  count. `cd specs; sed -i -e 's/a/b/' notas.txt` passes even if `specs` has stories. If one of those files is a story,
  the brake tries the `sed` on its text without writing it: if the header's `status:` stays the same, it passes, like
  the body edited with the editing tool; if it changes, it stops. With an editor in the position in another form, the
  folder of a `cd <carpeta> && ` at the exact start of the command (the folder written as it is, without quotes,
  options, `$` or wildcards), followed by a single `sed` that names its files (without a pipe, `$(…)`, backticks, another
  command, redirection, line break, braces, `@` or `~`), is where the other words are read from, not something the
  editor writes. Not with `perl`: a `perl -e` can build and write its files from the inside (`BEGIN{@ARGV=glob …}`), and
  it still stops. `cd <repo> && sed -i -e 's/a/b/' x.sh` passes even if there are stories inside that folder. An editor
  that takes its files from a pipe or from `$(ls)` (`cd specs && ls | xargs sed -i …`) still stops.
  `cd specs && sed -i -e 's/a/b/' story-x.md` still stops, and so does any other way of reaching the folder (`;`, `|`,
  a stuck-together `&&`, a space or a `(` in front, `cd -- x`, `cd $D`, `pushd`). Outside that form, a `cd`'s folder
  counts for the stories it has, written relative or absolute, with quotes or with spaces, with its wildcard expanded
  (`cd docs/st*`): `cd docs/stories && ls | xargs sed -i …` stops from the repo root. A folder the brake cannot resolve
  (`cd $(pwd)/docs`, `$'…'`, braces, a variable it does not know) also stops, and so does one with more `.md` files than
  it walks through. A «cd» inside a quoted text or a heredoc does not count.
- **Moving to review or done by hand.** An Edit, a Write or a Codex `apply_patch` that moves the story to `review` or
  `done` stops even if the evidence is there. Instead: `marker.js update-story-status`, `update-pipeline-status` or
  `/tycon-pipeline close`. Doing it by hand (changing the status without the command) is the person's decision: they sign it with `marker.js sign-file cambiar-el-estado <historia>`, and the write comes afterwards with Edit or Write.
- **Deleting the marker.** Deleting or moving through the shell a run marker (`active/`, `active.json`), of this
  session or another one, stops with «BORRADO DEL ESTADO DEL PIPELINE» ("deletion of the pipeline state"). Instead:
  `marker.js clear` or `marker.js
  clear-session <sesión>`. It has no signature to skip it. The other files in the
  state folder work as always. **Brake accepted out of doubt:** `gh pr close 7 --delete-branch; gh pr view 7 --json state`
  stops with «BORRADO DEL ESTADO DEL PIPELINE» when the state folder is called `state` (`~/.tycon/state`).
  `--delete-branch` deletes a git branch, but that word is the only thing that makes the brake look at the command for
  ways of deleting the list does not know (`zip -m`, `rsync
  --remove-source-files`, `tar --remove-files`), and removing
  it lets them delete the marker. The way out: closing the pull request and reading its state in two commands. These do
  not open that reading: the short Windows aliases (`del`, `erase`, `rd`, `ren`, `mi`, `ri`) outside where a command
  starts («la deuda del cliente» in a text), a `find -exec` with a program that only reads (`wc`, `cat`, `grep`,
  `ls`…), and a `git checkout`, `restore` or `rm`, which state their paths: if it is the only thing that deletes, it
  stops only when one of those paths falls on the marker.
- **A `$(…)` in a report's name.** With the pipeline open, a `.md` or `.log` target (`>`, `>>` or `tee`) with a
  `$(date +F)` (format only from `%Y %m %d %H %M %S %s %j %y - _`), stuck to text, is read in full and the `$(…)` counts
  as a wildcard: `> out/run-$(date +%s).log` passes. It stops if the folder where it may land has stories, if the folder
  known to be touched is the pipeline state or the installed tree (also through a link or from another possible folder
  of the command), or with any other `$(…)`, another `date` option, the `$(…)` as a whole segment, a target that
  continues after a quote, braces or a wildcard written in the target, a `date` that the same command redefines
  (function, alias, `PATH=`) or a code target. **Brake accepted out of doubt:** `$(basename …)` in a target
  (`> $SP/suite-$(basename $f).log`) stops with «EDICIÓN INVISIBLE» ("invisible edit"). `basename /` gives `/`, and its
  output can open a folder the brake does not see. For a report with that name, write it with the editing tool or build
  the name beforehand in a variable with its literal value.

The brake on moving by hand also stops moving a story in implementation back to another status (for example to `draft`,
to write it through the shell afterwards), removing its header and changing its id. Through the shell, a draft passes
only if the command rewrites it entirely and leaves it as a draft; and deleting a story, taking it out of `.md` with an
`mv` or restoring an old version (`git checkout -- <historia>`, `git restore`) also stops. It is turned off with `TYCON_STATUS_GATE=off` in the hook's environment (tests that measure
the evidence use it), and each write it lets through that way is recorded; written in a command, `ESC-C1` stops it without the person's signature.

What it does not see: a script the agent writes to a file and then runs; `patch` or `git apply` with a patch that touches
the story; `git stash pop`; a link (`ln -sf`) over the marker; and the state folder's name split between a variable and
a wildcard (`cd ~/.claude/.tyc* && rm -rf act*`). The check for undeclared changes at close time and the commit's diff
see that; and if what went away is the marker, the second layer below sees it, when it goes missing.

### The after look: what the command wrote

The brake before the command decides by reading the command's text, and an interpreter the shell resolves at run time
(`${N:-node} x.js`, `"${CMD[@]}"`) is out of its sight. The second layer (`on-bash-write-after.js`) does not read the
command: it looks at what ended up written.

- **How it comes on.** In the **recording** mode: it compares and leaves the line in `gates.log`, without undoing,
  without stopping and without telling the agent. That way, for a week, it measures how much it would undo and in which
  command forms, before letting it undo. Undo is turned on with `TYCON_WRITE_AFTER_MODE=undo`, and only with `undo` (in
  upper or lower case): `on`, `1` or `true` keep recording. Below it says what each mode does. It is registered as a brake, because with undo it can stop:
  that is why, on a machine without the harness's Node, the Node floor stops it like the other before-command brakes. A brake that an earlier test left with undo stays on
  disk and stops again when it is turned on.
- **What it looks at.** Before each terminal command (Bash, PowerShell, Monitor) it takes a snapshot of what is
  protected: the stories that are not drafts, the drafts' status, the records and the markers. After the command, also
  if it fails, it compares by content. A command that only reads (`cat`, `grep`, `ls`, `git rev-parse`…) takes no
  snapshot: it cannot have written.
- **What it records.** What changed and should not have is recorded as `escritura-vista-despues` in `gates.log`: the
  session, the call id, the path and its class, what undo would do, the command's programs and its first 160
  characters, and the command's shape (git alone, git with another program, a harness script with another program, or
  something else). With git in the command, also whether what was left equals what was committed. Never the file's
  content. In the recording mode, with `status: would-undo`; with undo, `undone`.
- **What it undoes, with undo on.** What changed and should not have goes back to what the snapshot had, or is deleted
  if it did not exist, and the notice reaches the agent.
- **What it does not undo.** What `marker.js` or an installed harness script wrote, alone in the command; what a command
  that is only git brought in and that equals what was committed. A change that another live session on the same working
  copy may have made, or an edit by the same session on that file at the same time, is not undone: it is left as
  `escritura-dudosa`, recorded (and, with undo, notified).
- **When it cannot look.** If the snapshot is missing, cannot be read or does not match its fingerprint: in the recording
  mode `mirada-fallida` is left in `gates.log` and the command goes on. With undo on, or if it could not undo, the
  session is stopped: it runs only reads until another session releases it with
  `marker.js release-write-after --for-session <S> --reason "<qué miró>"`. The signature is an exception: the person
  gives it, or the designated coordinator if the profile delegates it; never the stopped session nor the routine
  signature. A state folder that cannot be written to stops as well, and the folder is fixed.
- **What it does not see.** A process the command leaves alive (`&`, `nohup`, the Monitor command and the Bash one with
  `run_in_background`, which run in the background) and that writes when the command has already finished; a command cut
  by time that does not reach the after event; a command the person cancels with Esc (no event arrives); a script that
  writes in another repo without naming it with `cd`. In Codex it is not registered (the asymmetry is declared in
  `adapters/codex/hooks.json`): there the before-command brake remains. For all of that, the commit's net remains.
- **How it is turned off.** With the same switch as the before-command brake: `TYCON_STORY_GATE=off`. That switch also
  turns off the before-command brake and the edit gate: there is no switch that turns off only this piece.

### The lost run

The list of ways to delete the marker is never complete. That is why there is a second layer that looks at the effect,
not at the command: each run leaves three pieces that watch each other.

- **The marker** of the session, in the state folder.
- **The opening** in `gates.log`: a `run-open` line with the session, the story, the run's folder and the time.
- **The copy of the opening** in the repo's run folder (`.advisors/pipeline-runs/<ejecución>/run-open.json`).

Every legitimate close writes its `run-close` in `gates.log` and deletes the copy: `marker.js clear`, `clear-session`,
`adopt-session` (it closes the old one and opens the new one), the two prunings of old markers and the replacement by
another story. If a run is still open and a piece is missing, the run is **lost**: the marker is missing; there is a copy
without its opening or without `gates.log`; the copy does not match its opening, cannot be read or carries fields from a
close; or `gates.log` cannot be read. What cannot be decided stops.

With the run lost, these stop, with the «🔴 EJECUCIÓN PERDIDA» ("lost run") banner (which piece is missing, the story and
when it was opened): every code edit (Edit, Write, `apply_patch`), also with an ad-hoc lane or with `story_gate: false`;
the commit in the run's repo; and in the shell, everything that is not on a closed list. The list:
`marker.js` and `pipeline.js` for reading and for the way out, `git status`, `git diff`, `git log`, and `cat`, `ls`,
`grep`, `head` and `tail` without redirection. `gates.log` and `run-open.json` are also protected paths of the first
layer, next to the marker.

**Closing the turn stops once per turn: the turn closes on the second try.** The first close with the run lost stops with the banner; the
second in a row lets the turn close, with the banner for the person (the agent does not need to copy it), and writes in
`gates.log` an `ejecucion-perdida-espera` line. The next turn stops again on the first try. The counter lives in the
state folder (`lost-run-stop/<sesión>.json`) and names the opening; `stop_hook_active` decides nothing, because any
close hook sets it. If the counter cannot be read or written, it always stops. Letting the turn close opens nothing
else: editing, writing through the shell, committing and `marker.js clear` stay stopped until the signature.

**The way out belongs to the owner.** The signature in the permission window, with a click or an «aprobado» where the
window does not reach, or in their terminal with `--terminal`, on one of these two commands:

- `marker.js clear-session <sesión> --lost`: writes `run-close` with `estado: perdida`, the signature's route and the time, and deletes the copy.
- `marker.js restore <sesión>`: reopens the run from the repo's copy (a new marker and `run-open` with
  `motivo: restaurada`).

Both ask for the signature also for another session, and `ESC-C3` stops them without it.
`clear-session <sesión>` without `--lost` and without a marker closes nothing and says that `--lost` is needed.

The banner gives each command in its two forms, with the stable path of `marker.js` under the home folder, in double
quotes and without `~` (Windows PowerShell does not expand it) or the version's numbered folder (it changes on update):

- **the window one**: `node "<carpeta personal>/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js" clear-session <sesión> --lost`.
  The agent launches it through the Bash shell and the person approves it in the box;
- **the terminal one**: the same with `--terminal --for-session <sesión>` at the end. With the tool's PowerShell shell
  or in Codex there is no box, and this one is used. It works the same in Windows PowerShell 5.1, PowerShell 7, cmd and bash.

With a home folder that cannot be quoted (it carries `$`, `"` or a backtick), the command comes out with `$HOME`, which
is not a window signature, and the banner sends it to the terminal.

**Deleting or moving the folder of an open run stops before.** If a story's working folder is deleted while its run is
open, its copy of the opening goes with it and the run is lost. The shell stops, with the «🔒 CERRÁ LA EJECUCIÓN ANTES»
("close the run first") banner (the story, the session and the command), these commands on a folder that contains the
folder of an open run, or on one above it: `git worktree remove` (also with `--force` and with
`git -C <principal>`), `git worktree move`, `mv`, `Move-Item`, `Rename-Item`, `rm -r`, `Remove-Item -Recurse`, `rd /s`
and `cmd /c rmdir`. Also `git worktree prune`, if it prunes a folder that no longer exists with an open run inside; with
a git that does not say what it prunes (older than 2.31) it stops if there is an open run on the machine. «Open» is read
in `gates.log`: the session's last line is `run-open`. An old copy without a current opening does not stop. The way out
is to close the run with `marker.js clear` before deleting or moving the folder (`clear-session <sesión>` from its own
session, if it belongs to another one), and repeat the command. If `gates.log` cannot be read, it stops with the reason.
The sweep of already merged folders (`worktree-sweep.js`) does not delete a folder with an open run either: it names it
with the story and the session. What it does not see: a script that deletes from the inside (`tycon-worktree.sh rm`,
`node -e`), `git clean -fdx` inside the folder, and the file explorer or the IDE. There the usual cure remains: the lost
run.

Limit: if the three pieces are deleted, the session does not see it. The CI gate sees it, since it asks for the story's
authorship record before merging.

## Block log

Each block is logged in `~/.claude/safety-guard.log`:

```
[2026-05-23 13:36:42] BLOCK rule=FS-C2 cwd=/Users/<usuario>/SourceCode/Ceibo
  cmd: rm -rf /
  reason: rm -rf sobre raíz '/'. Irreversible y catastrófico.
```

Useful for:

- **Post-incident retro** — "what did the agent try to run that it should not have?"
- **Denylist calibration** — if a pattern fires a lot on legitimate cases, adjust the rule.
- **Metrics for `tycon-retrospective-capturer`** — feed the harness's quality dashboard.

## Troubleshooting

**The hook does not block when it should:**

1. Check that it is installed in `~/.claude/settings.json`:
   ```bash
   grep safety-guard ~/.claude/settings.json
   ```
2. Check that Claude Code loaded it (hooks are read at the start of the session — restart if not).
3. Try the script directly (see "Turning it on", step 5).
4. If «safety-guard no pudo leer este comando y lo frenó» ("safety-guard could not read this command and stopped it") shows up, the hook could not read its input: it does not need `jq` (it reads with `jq` if present and, if not, with `node`), but without either of them in the PATH the tool started with, it stops every command, because without reading it, it cannot know whether it is destructive. Fix: make sure `node` is in that PATH and restart the session. `test-scope-guard-pre.sh` in the same case lets the command through with a warning («NO REVISÓ este comando», "did NOT review this command"), with the same fix.

**The hook blocks something legitimate (false positive):**

1. Have the person sign the emergency in their terminal with the number from the banner (`harness.js sign emergency --reason "<por qué>" --request <número>`) and repeat the command as it is.
2. If the rule is badly calibrated (it blocks many legitimate cases), open an issue in the harness with the case. The rule can be refined or given an exception.

**I want to try new rules without affecting the real one:**

Use `TYCON_SETTINGS_PATH=/tmp/test-settings.json` with the installer:

```bash
cp ~/.claude/settings.json /tmp/test-settings.json
TYCON_SETTINGS_PATH=/tmp/test-settings.json \
TYCON_SAFETY_GUARD=1 \
  bash ~/.claude/tycon-harness/scripts/install-tycon-hooks.sh
```

## The machine's secrets are covered, not blocked

The brake looks at the command, and that is not enough for secrets: `env | grep ALGO` looks harmless and `node guion.js` does not say what it prints. That is why there is another piece, `scripts/hooks/cover-secrets.js`, which looks at the result: it replaces with `«tapado»` ("covered") every occurrence of a real value of the machine in what `Bash`, `PowerShell`, `Read` and `Grep` return, and leaves the rest the same byte for byte. The command runs anyway and with its exit code. You can keep looking at your configuration: you see everything except the values. It applies to what ends well: a command that fails is left out (below).

**Which values:** environment variables with `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY` or `APIKEY` in the name, with `_PAT_` in the middle, or ending in `_PAT` or `_KEY`; assignments with those names in `~/.zshrc`, `~/.zprofile`, `~/.bashrc` and `~/.claude/channels/*/.env`; the machine configuration's keys with those names or of type `secreto`; and all the values in the integrations' store, `secrets/<integración>.json` in the harness home. Values under 16 characters are left out and, except in that store, paths and addresses without a credential. It compares by exact value: an example key in a test file comes out as it is.

**To know whether something is there, without seeing it:** `tycon-config.js get <clave>` for a configuration key; `[ -n "$VARIABLE" ] && echo está` for a variable. It is turned off with `TYCON_COVER_SECRETS=0`. Log: `cover-secrets.jsonl` in the state folder, with the count and the source, never the value or the command; errors in `cover-secrets-errors.log`, without values.

**What it does not catch:**

- **A command that ends with an error, in Claude.** Claude Code does not pass that result through this hook: it sends it to another event, which carries the output and does not allow changing it. What a failing command prints reaches the model and the saved conversation in full. When uploaded to the mailbox it is covered, if the value is known.
- **Codex.** It has no way to rewrite an output: the hook answers `decision: "block"` with the covered output as the reason. The command already ran and the model sees the covered output, but it is presented as a script error, and the original stays in its conversation file.
- **A large Claude output.** Claude Code saves the full original in a separate file, `tool-results/`, next to the conversation. The model and the saved conversation see it covered, also if it reads it later, but the file keeps the value.
- **A hook cut by time.** If the tool cuts it, the value passes without being recorded.
- **A file rewritten from what was read.** An agent that reads `~/.zshrc` and writes it back in full may save the literal `«tapado»` instead of the value.
- **A multi-line assignment in a shell file:** it is read line by line, and that value is not known unless it is also in the environment.
- **What the machine does not know:** the password in a product's configuration, or a value that is split or encoded. It is against carelessness, not against someone who wants to get it out on purpose.
- **`Edit`.** It does not go through this hook. The model does not see the value, but the saved conversation keeps the whole file that its response carries, even if the previous read came out covered. When uploaded to the mailbox it is covered, if the value is known.
- **Other tools:** `mcp__*`, `WebFetch` and `Glob` do not go through this hook. In the measurement none of them returned a real value.
- **What is already in the mailbox.** Covering on upload does not clean what was uploaded before: that is solved by changing the tokens.

## Limitations v1 + roadmap v2

**v1 does NOT cover:**

- **Read/Edit/Write tool calls** — the hook only intercepts `Bash`. A `Read` call on `~/.ssh/id_rsa` still works, although if the file carries a known value it comes out covered (above). To cover that we need a `PreToolUse` hook with matcher `Read|Edit|Write` and a path denylist. v2.
- **Freeze mode** — limiting edits to one directory. It requires persistent state between hook invocations (which scope you froze). v2.
- **Autonomous guard mode** — Careful + Freeze combined, turned on automatically with `tycon-pipeline --autonomous`. v2.

**Roadmap v2 (proposed, no commitment):**

1. A `PreToolUse` hook with matcher `Read|Edit|Write` for a path denylist (.ssh, .aws, .env, secrets/).
2. Freeze mode with state in `~/.claude/safety-guard-state.json`.
3. Guard turned on automatically by `tycon-pipeline --autonomous`.
4. A metric for the `tycon-retrospective-capturer` dashboard (number of blocks / week, top rules fired).

## References

- Script: [`scripts/hooks/safety-guard-pre.sh`](../scripts/hooks/safety-guard-pre.sh)
- Installer: [`scripts/install-tycon-hooks.sh`](../scripts/install-tycon-hooks.sh) — `OPTIN_HOOKS` section
- Rules catalog: [`advisor-rules-catalog.md`](advisor-rules-catalog.md) — entries `FS-*`, `GIT-*`, `SUP-*`, `PUB-*`, `SQL-*`, `SEC-*`
- Complementary .NET hooks: the bizuit pack's `dotnet-hooks.md` guide — blocks already committed SQL migrations
- Inspiration: [ECC safety-guard](https://github.com/affaan-m/ECC/blob/main/skills/safety-guard/SKILL.md)
