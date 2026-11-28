# Production with permission

In Spanish: [production-with-permission.md](production-with-permission.md).

**Each query to a production database is approved one at a time, and the password does not go through the
conversation.** This guide is for the dev who uses it, and for anyone who wants to understand why it is there.

## Why it exists

A permission given for one task does not hold for the next one. Without a brake, **the assistant can keep
querying production in the next turn without asking for permission**, and even **open a firewall rule
on the production server**. That they are reads changes nothing: a rule
—"each statement is approved"— written in the assistant's memory is not enough.

Two causes, and both are fixed with the same thing:

1. **The rule lived in memory.** A control you have to remember to invoke is a control that
   does not run.
2. **The password was at hand.** With the key available, no brake that reads the text of a
   command is a boundary: a script or a variable goes around it.

## How it works, one line each

- **A single gate**: `/opt/tycon/bin/tycon-prod-sql <host> '<sentencia>'`. It is the only thing that queries
  or changes production —a `select`, or a change such as `alter database …`—, and **a person approves each statement
  before the key is read**. From your terminal, the gate itself opens a system dialog box with the server and the
  statement. When a Claude Code session asks for it (a statement or any other form with a box), the gate does not open that box: it prints the question, the session shows it
  to you in its options box and your click approves it, also from your phone or the app. Always a single box per
  statement: Claude Code does not ask about the gate on top of that.
- **A brake** forbids every other path to that database: direct `sqlcmd`, `az sql`, a connection
  string, reading the key from the Keychain, writing the catalog, or invoking the gate in any form
  other than the canonical one. It also looks inside the scripts the command runs, even if they were already
  on disk, and inside what `npm run` and `make` run. Naming the gate to read it or search for it
  (`cat`, `grep`, `less`, `git log`) is not invoking it; with a program that can run it, it is: `find -exec`,
  `rg --pre`, `sort --compress-program`, `git -c core.pager=…` or a git subcommand that runs something (`difftool`,
  `rebase --exec`, `grep -O`), `less +!…`, `awk`, `sed`, `open`, a variable in front of the program that is not about
  language, time zone or colors (`GIT_PAGER=<programa>`), `env -S` or `time -p` with the gate, a `$( … )` that runs it
  (`echo "$(<puerta> …)"`), a `<( … )` or `>( … )`, or a pipe to something that is not a reader (`| sh`, `| xargs`,
  `| python3`, `| awk`). To read it, `cat`, `head`, `grep` or `git show`; not `sed` or `awk`.
- **A catalog per project** (`<repo>/.tycon/production.json`) says which servers are
  production. **Whatever nobody declared is treated as production**, so a new server is stopped
  until someone declares it.
- **The brake lives in root's managed configuration**, which is the only thing that withstands
  `disableAllHooks`, another session and the Monitor tool. It has no variable that turns it off.

## Emergency: production is down

When production is down (for example, the database reached its cap and stopped writing), the path is the same gate.
You do not need the Azure portal, or someone dictating the commands to you. Each step that touches production is
approved by **the person** who must be able to authorize that change on that database: with their click in the session
(also from the phone), or in the system box if they run the gate from their terminal.

1. **Test the connection**: `/opt/tycon/bin/tycon-prod-sql <host> 'select 1'`.
2. **If the firewall rejects it** (error 40615, «is not allowed to access the server»), the gate says so and gives the
   command: `/opt/tycon/bin/tycon-prod-sql --open-firewall <host>`. **The session runs it** and the person approves it
   with their click in the session. It opens the rule for this machine in that session's name, and the rule closes by
   itself when the session ends, or after 8 h. If Claude Code's automatic mode does not let it run, the session tells
   the person in one line, with the command for their terminal: the same one with `--session <id>`.
3. **Check the state** through the gate, not through `az`: the size and the cap with
   `'select name, size/128 as mb, max_size/128 as max_mb from sys.database_files'`, and the edition and the tier with
   `'select edition, service_objective from sys.database_service_objectives'`. They measure the database the gate
   enters: the server's `base` in its catalog; if the catalog does not declare it, the gate enters `master` and what
   you see is `master`.
4. **Mitigate with a statement**, which the person approves in the box. For example, raising the cap:
   `/opt/tycon/bin/tycon-prod-sql <host> 'alter database [<base>] modify (maxsize = 250 GB)'`. The service tier
   is changed the same way (`modify (service_objective = '…')`, with the quote escaped as in the shell).
5. **Tell the person what changed** and write it down in the incident. The firewall rule closes by itself; if you want
   to close it now: `--close-firewall <host>`.

## Admin changes in Azure: alerts, size or plan

What changes a production resource in Azure without connecting to the database —a space alert, the size or the plan
of the database— also goes through the gate, with the same box and logged in `production.log`. It is **the same
`az` command, without the word `az`**, with each argument as a plain word or in single quotes:

```bash
# una alerta de espacio al 80 % (el cuadro muestra el comando entero; la persona lo aprueba)
/opt/tycon/bin/tycon-prod-sql --azure monitor metrics alert create -n espacio-80 -g <grupo> --scopes <id del recurso de la base> --condition 'avg storage_percent > 80'

# las lecturas no cambian nada: corren sin cuadro, y quedan anotadas igual
/opt/tycon/bin/tycon-prod-sql --azure monitor metrics alert list -g <grupo>
```

- **With a box**: `monitor metrics alert create|update|delete`, `sql db update` and `sql elastic-pool update`.
- **Without a box, read only**: `monitor metrics alert list|show`, `monitor metrics list|list-definitions`,
  `sql db list|show|list-usages|list-editions`, `sql server list|show` and `sql elastic-pool list|show`.
- **The firewall rule** does not go this way: the one for this machine is `--open-firewall <host>`.
- **Everything else has no approved path** (deleting a database or a server, changing a lock, another firewall rule):
  the brake says so, and the assistant leaves the command to the person to run in their terminal, telling them what it
  does. It is not disguised or split up so it gets through.
- **An argument with `@` at the start or after a `=`** (`@ruta`, `--name=@ruta`, `--set clave=@ruta`) does not pass:
  `az` would read the contents of a file, and neither the box nor the person sees it. Neither do
  `--debug` or `--verbose`: `az` would print the requests with their headers, and the credential would reach the conversation.

When the brake cuts an `az` command that has a path, the message carries the same command through the gate, ready to run.

What is stopped all the same, even in an emergency: direct `sqlcmd`, `az sql …` against a production server (also
reads, such as `az sql db list`; the brake says which query to use instead) and a firewall rule created with
`az`. All the forms of the gate, without touching production: `/opt/tycon/bin/tycon-prod-sql --help`.

## Install it (once per machine, only whoever touches production)

```bash
open ~/.claude/tycon-harness/scripts/production/install-guard.command
```

It asks for your Mac password once and clears the cache when it finishes. **The new hooks become active
in the NEXT** Claude Code session.

The order when adding someone is **first the brake, then the key**: a machine with the key and
without the brake is the dangerous state (and the startup notice shouts it).

### Update it without a password (if the organization chose it)

By default, each brake update asks for your password. If the organization chose «solo, desde la versión publicada»
("on its own, from the published version") on the site (`guard.update: auto`), you can install ONCE, with your password,
a narrow `sudo` permission:

```bash
sudo bash ~/.tycon/harness/scripts/production/install-guard.sh --allow-auto-update
```

What it enables: running as root, without a password, a single script and with no arguments, `sudo -n
/opt/tycon/setup/update-guard.sh`. The script installs the published version of the brake, verified against GitHub. It
only moves forward, never back. It does not pin a new origin, and without network it does nothing. A version that brings
another installer, an origin that changed (even an official move) or a downloaded version with symbolic links is not
installed on its own: those ask for your password. Each update is recorded in
`/opt/tycon/production/update-log.jsonl`, and the startup notice shows the last one. It refuses if your machine does not
have the permission, or if your machine's team profile says «con la contraseña» ("with the password"): touching that
profile can only turn it off, never on.

**Who launches it.** When a session opens, a startup hook checks whether there is a published version newer than the
installed one. If there is, and the machine has the permission and the organization chose «solo» ("on its own"), it
launches `sudo -n
/opt/tycon/setup/update-guard.sh` as a separate process: it does not wait for it or hold up startup. It does not launch
it again for a version that already failed, until another one is published.

**Before replacing anything, it rehearses the new brake.** The installer builds in a temporary folder the same layout as
`/opt/tycon`, from the verified copy, and runs the new brake there with your user, without your variables or your catalogs:
an ordinary command (`ls`) has to pass and a database one (`sqlcmd`) has to be stopped. If not, it does not touch
`/opt/tycon` and records why. The temporary folder is always deleted. What the rehearsal does not test: the brake's
launcher (`node-shim.sh`), the gate (`tycon-prod-sql`) and the interpreter (`node-official.json`), which go by fixed paths
in `/opt/tycon`. That is why a version that changes any of them, or the installer, is not installed on its own: it
records the failure and asks for your password.

**If it fails, the previous one keeps working.** Each attempt that ends in error, by whatever path, leaves in
`/opt/tycon/production/update-log.jsonl` a line with the version it tried, the reason and the time. The startup notice
says which version is still working, which one failed and why, and gives the command with your password:

```bash
sudo bash ~/.tycon/harness/scripts/production/install-guard.sh
```

It is also the way out if the rehearsal stopped too much. Meanwhile the old brake decides as before. If the brake is out
of date and there is no recorded failure, the notice says whether it is being updated (another update in progress, or a
version published less than a day ago) or gives the command.

**How it is turned on in an organization.** First, a pull request to the team profile repo with `guard.update: auto`,
which the owner approves. Then, each production machine runs once, with its password, the
`install-guard.sh --allow-auto-update` above. To find out what your machine is missing,
`node ~/.tycon/harness/scripts/tools/prepare-machine.js` tells you, with the command, and does not run it.

What it costs, stated up front:

- **Any program running with your user can request that update.** `sudo` does not tell one session from
  another, so the agent, a script or a hook can also trigger it. They cannot choose what gets installed: the script only
  catches up with what is published.
- **The published brake is adopted without a person at the keyboard.** Today the password is a conscious decision to
  adopt. With the permission, a weaker published brake arrives on its own. The anchor is still the team repo on GitHub,
  with its pull requests and its review.
- **If the organization goes back to «con la contraseña» ("with the password"), your machine does not change on its
  own.** The startup notice gives you the command to remove the permission. Until you remove it, an agent that rewrites
  your machine's profile to «solo» ("on its own") can keep updating it.

To remove it, and go back to the password every time:

```bash
sudo bash ~/.tycon/harness/scripts/production/install-guard.sh --remove-auto-update
```

### The English names

The folder is `scripts/production/`, the installer is `install-guard.command` (the `.command` with its old name
still opens this one), the catalog is `.tycon/production.json` with the keys `servers`,
`environment`, `keychain` and `port`, and the index and the memory are `production-index.json` and `production-memory.json`.
The values of `environment` are `production` and `non-production`; `produccion` and `no-produccion` are still valid, and
the index always stores the latter, because the copy in `/opt/tycon` is the one that reads it. A machine with a harness
older than the English values does not recognize `production` or `non-production`: it treats that server as undeclared
and stops it (it never lets it through). For a repo shared by machines that have not updated yet, it is better to keep
the old ones.

What really runs is the copy in `/opt/tycon`, and that one changes only when each person **reinstalls with their
password**. What the brake does with the old names:

- **the catalog** is still read and protected under both names and its old keys, until the products
  migrate it. A new catalog is better written with the new name. Having both catalogs in the same repo is an
  error: the commit is not created;
- **the index, the memory and the log** are written and protected only under the new name. The old memory and
  index are moved **once** to the new ones on regeneration (merging only adds production servers) and deleted; from
  then on, a server lowered with `--reclassify` does not come back. If the old memory is tampered with or cannot be read,
  it stays, and the brake decides nothing about databases until you resolve it: `--verify` if only the old one was
  touched, `--reclassify <host>` if not. On reinstall, the installer deletes the old files already present in the new
  ones, and leaves the rest and says so;
- **the machine configuration**: the brake reads only `paths` and `integrations` from `~/.claude/tycon.json`. With their
  Spanish names, it ignores them and says so: the index is built without that configuration, and what it cannot find it stops;
- the gate options are `--load-key`, `--reclassify`, `--verify` and `--max-rows`. Until you reinstall, the installed gate
  understands only the old ones; the startup notice names the one your gate understands, and says **«el freno
  quedó viejo: reinstalalo»** ("the brake is out of date: reinstall it") (never «alguien lo cambió», "someone changed
  it"). On reinstall, the installer carries over on its own the origin you had already accepted and removes the old
  managed file (a backup stays next to it).

## Load the key (the first time)

Do not type it in the chat, or hand it to the assistant. A command leaves on your Desktop a
`cargar-clave-<entrada>.command` file and opens it:

```bash
/opt/tycon/bin/tycon-prod-sql --load-key <host>
```

There you enter the user and password, and the file deletes itself. The entry goes into a keychain of its own
(`~/Library/Keychains/tycon-prod.keychain-db`) that trusts **only** the system tool.
(If you forget this step, the first query does the same and exits without querying.)

## Day to day

```bash
# consultar producción (se abre el cuadro: leelo antes de aprobar)
/opt/tycon/bin/tycon-prod-sql acme-sql.database.windows.net 'select top 10 * from Articulos'

# un cambio va por el mismo camino, con el mismo cuadro
/opt/tycon/bin/tycon-prod-sql <host> 'alter database [acme] modify (maxsize = 250 GB)'

# todas las formas (no toca producción)
/opt/tycon/bin/tycon-prod-sql --help

# más filas de las 50 por defecto
/opt/tycon/bin/tycon-prod-sql <host> 'select …' --max-rows 200

# revisar que la entrada del Llavero siga sana (no lee la contraseña)
/opt/tycon/bin/tycon-prod-sql --verify

# un host que ya NO es producción (queda en el registro, y lo aprobás en el cuadro)
/opt/tycon/bin/tycon-prod-sql --reclassify <host>
```

🔴 **The whole point of this is that each statement gets looked at.** And if a Keychain box shows up **without you
having approved a statement first**, deny it: something is reading the key by another path.

**From a Claude Code session, you approve it with a click in the session.** The system box is shown only on the
Mac's screen: if you follow the session from your phone, from claude.ai or from Claude Desktop, it does not reach you and
the query expires. That is why, when a session calls the gate, it does not open the system box: it exits without
querying and prints the question, with the server, the whole statement, the session and a code specific to that
statement. The session shows it to you with its options box, without changing a letter, with «Sí, aprobar» ("Yes,
approve") and «No». With your click, the session repeats the same command, and only then does the gate read the key and
query. **A single box per statement**: on this path the system one does not open, neither before nor after (the gate's
suite tests it, counting the boxes on each path).

The gate verifies the click the same way as the signatures for control changes: it reads in the session's conversation
your answer to that exact question, with that code, answered by you and not by a hook. **It is the same security as those
signatures, which is why it was chosen**: the same click that already approves a change to the harness controls approves
a statement. A click is good for a single statement and expires after 10 minutes. Another statement, another server,
another row cap or another session ask for another click. A written «aprobado» ("approved"), a message from another
session, one from the office or what the assistant says do not count. Your click in the session's tab or in the
confirmed coordinator's tab counts, like any click of yours. The rest does not change: the key is read only after the
approval, each statement goes into `production.log` (with `"aprobacion":"click-en-la-sesion"`), and the 1,200-character
cap is the same.

**From your terminal, without a session: a single window, the gate's.** It is a system box titled «Producción: ¿lo
aprobás?» ("Production: do you approve it?"), with who is asking, the server and the statement, and «Rechazar»
("Reject") selected by default. Only with «Aprobar» ("Approve") does the gate read the key and query. If you do not
answer within 2 minutes, it counts as rejected. Claude Code no longer opens its own permission on top: it added no
control, because without the gate's box nothing is queried (the gate's suite tests it), and it doubled the windows. The
same happens when lowering a server to non-production (`--reclassify`), opening the firewall (`--open-firewall`) and
deleting a resource group (`--delete-group`); closing the firewall, `--verify`, `--locks` and `--load-key` do not ask for a
box: they do not query or change anything that cannot be undone. When a session asks for them, those forms are also
approved with your click in the session. The question says what each one does, and starts with a warning when it turns
off the brake or when it cannot be undone, with the exact server or group: «APAGAR EL FRENO para <servidor>» ("TURN OFF
THE BRAKE for <server>") (`--reclassify`) or «BORRAR SIN VUELTA ATRÁS el grupo de recursos <grupo>» ("DELETE WITH NO WAY
BACK the resource group <group>") (`--delete-group`). Read that first line before the click: from the phone, one click
deletes a group forever or leaves a server without a brake. **The system box needs the Mac's session**: over SSH, or
from a session without a screen, the gate does not query (it fails closed, on purpose). And the statement has to fit
whole in the box: up to 1,200 characters in 20 lines of 60; a longer one is rejected before opening it, so that you never
approve a cut-off statement.

**The box says who is asking.** Its first line is the project folder and the session: «Pide: Cliente/Codigo · sesión
0123abcd (principal)» ("Asks: Cliente/Codigo · session 0123abcd (main)"). From a terminal, outside Claude Code, it says
that. If you do not recognize the session, reject.

**One box at a time.** If a request arrives while a box is open, it waits until you answer that one; they do not stack.
If nobody answers within 90 seconds, the waiting request exits without opening its box or reading the key, and says
which session has the box open. Whoever asked tries again later, one query at a time.

**A subagent does not use the gate.** The brake stops it with any form of the gate: the box is answered by a person who
is watching the main session, and a subagent, above all one in the background, stacks boxes on them about something they
are not following (it happened: nineteen queries in 26 seconds). The subagent returns the statements and the main
session runs them one at a time. Claude Code tells the brake when a subagent calls, but not whether it is a background
one: that is why all of them are stopped.

**The gate runs in the foreground.** Its box expires after 2 minutes, and a gate run in the background opens it without
anyone watching: the request cancels itself, without changing anything, and the session does not know what happened.
That is why the brake stops the gate when it is requested in the background (`run_in_background`) and when requested by
the Monitor, which always runs in the background. It stops every form, even a read that opens no box: the rule is a
single one. What to do is tell the person beforehand which box is going to appear and what they have to do in it, and
run the gate in the foreground with a 5-minute cap (`timeout: 300000`). The cap is needed because, when Claude Code's
console cap runs out (2 minutes unless another is requested), the console does not cut the command: it moves it to the
background, and the box is left with nobody watching it. The gate can wait up to 90 seconds for its turn and another 2
minutes for the box. That is why the brake also stops the gate in the foreground without that cap, or with a smaller
one: the message says which one it had and asks for the 5-minute one. It is the last thing it checks about the gate, so
a command with another problem is stopped first for that one. Each block is logged with the rule
`puerta-de-fondo`.

The cap the console applies also comes from its configuration, and the brake checks it:
- `BASH_DEFAULT_TIMEOUT_MS` of 5 minutes or more acts as the cap for a request that does not carry one;
- `BASH_MAX_TIMEOUT_MS` or `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` below 5 minutes cut it down, so the brake
  stops and names the variable. That configuration belongs to the person: they are told, it is not changed.

What the brake does not see yet:
- **A session opened in the background by the coordinator that runs the gate in its own foreground.** The box appears
  while the person is looking at another tab. Its first line says which folder and which session it comes from.
- **A command the console runs for another machine** (an attached session). There the cap is set by the console, shorter,
  and it does not reach the brake.
- **Deleting a resource group (`--delete-group`).** The gate queries Azure before opening the box, and in the worst
  case the 5 minutes are not enough.

**When it is not approved, the gate says why.** It exits with code 2, without reading the key or changing anything, with
one of three messages. All three start the same, «la persona no aprobó esta sentencia» ("the person did not approve this
statement") (or «operación», "operation"), and go on with the cause:

- **Expired** («el cuadro se venció a los 120 s sin respuesta», "the box expired after 120 s with no answer"): nobody
  answered in time. If the gate ran in the background, nobody saw the box: run the gate in the foreground, with the cap,
  and say beforehand which box is going to appear.
- **Rejected**: the person pressed «Rechazar» ("Reject"), that is, they said no. Ask them why before asking again.
- **No box** («el cuadro no se pudo abrir», "the box could not be opened"): the box program exited with an error, did not
  answer or answered something the gate does not understand. What is known goes in parentheses, such as the code the
  program exited with.

The production log records all three as `"accion":"rechazada"`, with their `"motivo"`: `vencido`, `rechazado` or
`sin-cuadro`. Only the exact «Aprobar» ("Approve") answer approves.

**The query always goes inline.** The box shows the command and nothing else: what a file brings is not seen
before approving, so the gate does not accept files. A query can take several lines inside
the single quotes. If you ask the gate for a file, the brake does not let the command through and, when the file
can be turned into an inline query, it gives you that command ready to run.

**Cap: about 20 screen lines of 60 columns and up to 1200 characters**, the same one the gate sets. The
box shows that much and cuts the beginning without warning, so a longer command does not pass: the brake says how much
it takes up and you have to split the query into shorter queries. A line longer than 60 columns counts as several,
and a tab or a wide character takes up more than one column.

**No misleading characters.** No control characters (a carriage return, a terminal sequence), no
invisible or direction characters: they would make the box show something other than what runs. The brake stops them
and, again, so does the gate.

The gate has a **fixed format** on purpose (it merges the error with the output, cuts rows, prints the
exit code): so there is no need to add `| head` or `2>&1`, which the canonical form does not accept.

## Declare a server

In the repo that has the migrations for that database (`database/` or `BD/`), and **only** with these
keys — the database user does NOT go here, it goes next to the password in the Keychain:

```json
{
  "servers": [
    { "host": "acme-sql.database.windows.net", "environment": "production", "keychain": "tycon-prod-acme", "base": "acmebase" },
    { "host": "srv.globex.test", "environment": "production", "keychain": "tycon-prod-globex", "base": "GlobexDb", "port": 1435 },
    { "host": "acme-sql-staging.database.windows.net", "environment": "non-production" },
    { "host": "acme-test.example.com", "environment": "non-production" }
  ]
}
```

`port` goes in **only if the server does not listen on 1433** — the typical case is a named
SQL Server instance on its own port. It is a number, without quotes, between 1 and 65535, and the
gate appends it to the host when connecting (`-S "host,puerto"`, which is what the client understands
for a named instance). **The instance name with a backslash is not needed and is still
rejected**: with the port you get there all the same.

🔴 **Why it is a field and not a comma inside `host`.** The host is the server's IDENTITY:
with it the gate looks it up in this catalog, builds the service name in the Keychain, and the brake
recognizes it when it appears in a command. If `host,1435` were allowed there, the same server
would have two spellings and the one that matters for stopping —the bare name— might not be declared.
With the port here, **the person still types only the name**, and no validation was loosened
to make this work. Valid since 2026-09-29.

`base` says which database the gate enters, and in Azure SQL **it is required**: there is no `USE` or
three-part names there, so without it the client enters `master` and every table gives «Invalid object name»
(measured against a real server, with the key already correct). It is optional for a server whose
user already lands in the right database.

A **non-production** server can be declared in any repo that uses it. The pre-commit
rejects the file if it has an extra key, an environment that does not exist, a `keychain` that does not
start with `tycon-prod-`, a `base` with brackets, quotes or spaces, or a `port` that is not
an integer in range.

**Production is sticky**: a host that was once seen as production does not go back to
non-production by rewriting a file or by deleting the index. The only thing that lowers it is
`--reclassify`, which goes through the box.

## The firewall: your machine's IP, through the gate

If your machine's IP is not allowed in the firewall of a production Azure SQL, the brake cuts
the Azure command that would create the rule, even if you authorize it in the chat. The path is the gate:

```bash
/opt/tycon/bin/tycon-prod-sql --open-firewall <host>     # cuadro de aprobación; abre la regla de esta máquina
/opt/tycon/bin/tycon-prod-sql --close-firewall <host>    # cuadro; la cierra
```

- **A single rule per machine and per server**, with the fixed name `tycon-gate-<id>` (a hash of the
  computer's identifier: it does not say whose machine it is), for a single IP. If your IP changed, the
  same rule is updated; there are never two. The gate does not accept ranges, `0.0.0.0`, «allow Azure
  services» or a rule name.
- **The IP comes from Azure SQL itself**: the gate tries to log in with a user that does not exist and without the
  key, and reads the IP from the rejection («Client with IP address … is not allowed»). It does not call any
  external service or read the Keychain. If the connection gets as far as asking for the key, you already have access
  and it opens nothing.
- **It closes by itself**: when the assistant session that asked for it ends, a hook in the managed
  configuration (`prod-firewall-close.js`) closes it, unless another live session is still using it. If the
  session end did not run (window closed abruptly, session crashed), the same hook closes it when
  any session on the machine starts (also a compaction or a `/clear`) and says so in one line.
  Closing does not ask for a box.
- **How long it really lasts**: as long as the session that asked for it lives, with a cap of **8 h** from when it was
  opened with its box. «Alive» is checked through its process, which Claude Code records in `~/.claude/sessions` (the
  same on macOS, Linux and Windows), so a session waiting for the person is still alive. If that record is not
  there, the fallback is its conversation's activity in the last 3 minutes, and the hook says so when
  closing. The cap is applied at the machine's first command, startup or session end after the
  8 h (the production brake launches the closing separately), and the notice carries the command to open it again.
  A rule without a readable opening date counts as expired. Opened from the terminal without `--session`, the rule
  belongs to no session and is closed at the next startup of any session.
- **If the server was deleted** with the rule open, the rule went with it. When opening, the gate records the server's
  subscription and group. When closing, it asks about that server there: if Azure answers that it
  does not exist, and it is not in another subscription either, it counts it as closed and says so. If it moved, it
  closes it where it is. A «no permission» does not count as deleted (Azure hides what your account no longer sees).
- **If the rule is from before the location was recorded**, the gate looks for the server in all your subscriptions.
  If it does not appear in any, it asks Azure whether its name is free (`checkNameAvailability`). Only with
  the name free does it count it as closed: the name forms the server's public address, so no
  server has it, not even one your account does not see. If the name is in use, if a subscription did not
  answer, if your account has no valid subscription, or if the answer is not clear, the rule stays
  recorded as open and the notice continues: «I don't know» does not count as closed.
- **The case that remains**: a server moved to a subscription your account cannot read counts as closed,
  even though the rule traveled with it; your account could not close it either.
- **What was left open** lives in `production-firewall.json` (in the state folder, next to
  `production.log`), protected like the production memory; each opening and each closing goes into
  `production.log`.
- Only for Azure SQL (`*.database.windows.net`): a SQL Server of your own, with `port`, does not go through here.

## Deleting in Azure: the group, the lock and the resource

Deleting a resource group takes everything inside it, including a production server with its databases. The
catalog declares servers, not groups, so **the brake does not know which group contains what**. That is why it stops all
these commands, without looking at the group name or the catalog, and without asking Azure:

- `az group delete`, in any form (with global options in front, with `sudo`, `az.cmd`, `az.exe`, hidden in
  `bash -c` or `xargs`).
- `az lock delete`: it removes the lock that protects against deletion. Creating, listing and viewing locks passes.
- `az rest` with the delete method, or with a method that comes from a variable: the address can be a group or a
  server. The other methods pass. The same goes for `Invoke-AzRestMethod -Method DELETE` in PowerShell.
- `az resource delete`, unless the type of everything it deletes can be read and none of it is `Microsoft.Sql`,
  `Microsoft.Resources` (the group) or `Microsoft.Authorization` (the lock). If it names a SQL server, the catalog
  decides as for any other command: production or unknown stops, a declared non-production passes. Without a readable
  type (a variable, a `-n` without `--resource-type`, a wildcard), it stops.
- `azd down`, which deletes an environment's resources.
- In PowerShell, `Remove-AzResourceGroup`, `Remove-AzResource`, `Remove-AzSqlServer`, `Remove-AzSqlDatabase` and
  `Remove-AzResourceLock`, always.
- Hidden deletion too: with the program in a variable (`$A group delete`), on the second line of the command,
  inside an `awk` or `sed` program, in the code of `python -c` or `node -e`, in a script that a shell runs, over
  `ssh` and with `xargs` when the subcommand comes from the input. A commit message that names these commands is not
  stopped: it is not a command.

A group that is **not** production (a test one) can be deleted by the assistant through the gate, with the approval
box:

```bash
/opt/tycon/bin/tycon-prod-sql --delete-group <grupo>     # sólo el nombre; antes de borrar, abre el cuadro
```

The gate asks Azure what is in the group and deletes it only if it can prove it is safe: the group is in a
single subscription, all its SQL servers are declared non-production, it has no database of a type the catalog
does not cover (Postgres, MySQL, MariaDB, a managed instance, Cosmos, Synapse) and the listings match. If not, it exits 2
without deleting and says why: a production server, an undeclared one, a truncated listing or `az` not answering. You
approve the deletion in the gate's box, which says the group, the subscription, how many resources and which servers it
has. It runs with `--no-wait`: the gate says Azure **accepted the request**, not that the group is gone, and gives the
command to confirm it (`az group exists`). A group with a lock is rejected by Azure, and the gate says so.

A group with something production in it, or that the gate cannot prove safe, is deleted by
**a person, in their own terminal**, outside the assistant, after looking at what it contains. The brake's message for a direct `az group delete`
names both paths: the gate (`--delete-group <grupo>`, which asks for the owner's approval in the box) for a group
that is not production, and a person for the rest. The cut is logged with the rule `borrado-de-azure`.

The limit: the brake covers the assistant's commands on this machine. It does **not** cover the Azure portal, Terraform, a
deployment with `az deployment group create --mode Complete` (it deletes what the template does not name), the SDKs or
another person. The real protection in Azure is a `CanNotDelete` lock on the production server, set by a person
with lock permission; the brake prevents the assistant from removing it.

## The lock: so nobody deletes the server by accident

The brake cuts the deletions the assistant runs, but it does not see the portal, Terraform or another person. The real
protection comes from Azure: a `CanNotDelete` lock on the production server (or on its group) makes Azure reject
the deletion, wherever it comes from. The lock **is set by a person** with lock permission
(`Microsoft.Authorization/locks/write`): it changes the client's Azure, and the assistant does not do it.

The gate tells you which ones have it, without changing anything:

```bash
/opt/tycon/bin/tycon-prod-sql --locks     # sin nada más; abre el cuadro de aprobación, como toda forma de la puerta, y sólo lee
```

For each declared production server in Azure SQL it says `con candado` (with its name and whether it is on the server or
on the group), `sin candado` or `no sé` (with the reason: no `az`, no login, the server in two subscriptions or in none,
or the catalog of a repo that could not be read: the others are checked anyway).
A `CanNotDelete` or `ReadOnly` lock on the server or its group counts. For one without a lock it prints the command, for
a person with lock permission to run it, outside the assistant:

```bash
az lock create --name tycon-no-borrar --lock-type CanNotDelete --resource-group <grupo> --resource-name <servidor> \
  --resource-type Microsoft.Sql/servers --subscription <suscripción>
```

What was measured: `az lock list` returns each lock with its `id`, `level` and `name`, and the `id` says whether it is the
group's or the server's. A lock takes a few seconds to go away: deleting the group right after removing it failed with
`ScopeLocked`, so you have to wait or retry. The limits: a lock can be removed by anyone with lock permission (not the
assistant, because the brake cuts `az lock delete`); the gate does not see subscription locks, and a server with one of
those can come out `sin candado`. It exits 2 if any server ended up as `no sé`.
Measured in Azure with a test server: with the `CanNotDelete` lock on the server, `--locks` says
`con candado`, Azure rejects the server's deletion with `ScopeLocked`, and **`--close-firewall` also fails with
`ScopeLocked`**: the firewall rule is a child resource of the server and the lock reaches it, so the rule the gate
opened stays open. That is why you should not put the lock on a real server whose firewall the gate opens: safe
closing stops working. How to combine the two is the owner's decision.

## The limits, stated up front

- 🔴 **The click in the session is verified by harness code, not root code.** The system box is opened by the gate, which
  belongs to root and has a fingerprint. The click is confirmed by the harness installed in your account
  (`scripts/production/session-approval.js` and the signature verification), reading the session's conversation. It is
  the same limit the control signatures have: a program that deliberately rewrites the conversation and the click log
  could fake it. It was accepted in exchange for being able to approve from the phone. If that is not enough for you, run
  the gate from your terminal: the system box is still there.
- **The change reaches each machine when the brake is reinstalled.** The gate lives in `/opt/tycon` and is installed with
  your password: until you reinstall it, a session keeps opening the system box.

- 🔴 **The rule that asks about `az sql server firewall-rule` is a COURTESY one**, not a brake: it can be
  dodged by splitting a word in two (`az sql ser''ver …`). For production and for the unknown
  the control is the **hook**, which runs before the rules and cannot be dodged that way. Do not trust the
  firewall box as if it were a barrier. To allow your IP, the path is the gate
  (`--open-firewall`).
- **`az` belongs to the user** (Homebrew or Microsoft's installer), not a root binary with a fingerprint:
  it breaks the gate's rule and is accepted under three conditions: it is looked up in fixed paths, never in the
  `PATH`; it never receives the database key or anything from the Keychain; and it is only asked for `account list`,
  `sql server list`, `sql server show` and `sql server firewall-rule show|create|update|delete` on `tycon-gate-<id>`,
  and the check of whether a server name is free (read only). An
  `az` replaced in one of those paths does not see the key, but it can create another rule with your account:
  your Azure account could already do that by hand.
- **The session end may not run** (window closed abruptly, session crashed): the rule stays open
  until the next startup on that machine, which closes it. A machine that does not open a
  session again leaves it open until someone does: that is the cost of not having an expiry by hours.
- **An idle session counts as ended**: «alive» is activity in the last 3 minutes. If its rule is
  closed, it opens it again with the box.
- **Codex does not open rules**: it has neither the managed configuration's box nor a session-end
  event.
- **The production password also lives in other places** this does not touch: the App Service
  configuration, `dotnet user-secrets`, and an `appsettings.Production.json` if someone downloads it.
- 🔴 **Any program in your account can read the key** with `/usr/bin/security`, without a box: the
  Keychain entry trusts that tool, and the keychain does not lock by itself. A program that
  connects internally (Python with `pyodbc`, a custom `node`) does not name the server and the brake does not see it.
  What stops it is something else: the brake looks inside the scripts the command runs and stops if
  they name a declared keychain or server. Closing this completely (only the gate being able to read the
  key, with Touch ID) is the next step, not done yet.
- **The brake reads text.** A name split into pieces that is assembled at run time, an interpreter that receives
  the program with `-e` or `-c` and builds it internally (`node -e`, `python3 -c` with a list of
  arguments), or a file whose name arrives only at run time (`find … -exec bash {} \;`,
  `echo x | xargs bash`) are not seen. Neither are the `make -n` recipes that run anyway (the ones that
  start with `+` or call `$(MAKE)`): with `-n` the brake does not look at the recipes. And there are two `make` readings
  the brake does not do, on purpose, so as not to keep growing it: a pattern rule that builds a missing `include` (`make`
  runs it even with `-n`), and a `${call shell,…}` with braces inside the braces, which is neither read nor warned about.
  That is why approval no longer depends on the brake: the gate asks for it, even when a script or a custom hook calls it.
- **The gate's box can be pressed by an application with Accessibility permission** (the terminal or
  the editor where the assistant runs, if you gave it that). The brake stops the commands it sees trying it
  (`osascript` with System Events and a click or a keystroke, `cliclick`), but that is text again. Touch ID,
  when it arrives, cannot be answered by any program.
- **Claude Code's no-permissions mode** (`--permission-mode bypassPermissions`) respects the rules that
  ask, according to its documentation and to the live test with a toy rule. Even so, the gate's box
  does not depend on that mode: the gate asks for it.
- **A script larger than 64 KB, or one that cannot be read, is not looked at.** Neither is an `npm run` without that
  script in `package.json`, or a `make` recipe that cannot be found. The brake lets it through (it does not stop
  normal work for not being able to read) and records it in the production log as «no mirado» ("not looked at").
- **Without a shell snapshot, the brake asks the live login shell** what each name that
  could take over the gate is (since 2026-09-16: Claude Code 2.1.272 no longer writes a snapshot and
  runs each command as `zsh -c -l`). A startup file that lies to that question
  (redefining `builtin`, for example) dodges it — the same limit the snapshot already had, since it was
  also produced by that shell. What the brake does require is that `command`, `builtin` and `whence`
  remain builtins: if not, it stops.
- **The `sudo` cache** leaves a window in which deleting the brake does not ask for a password. The
  installer runs `sudo -K` when it finishes; if you want to close it further, lower `timestamp_timeout`.
- **Catching up depends on what the organization chose** (`guard.update`, on the site). With «con la contraseña» ("with
  the password") (the default), updating the brake asks for `sudo`: until you run it, the machine has the old version,
  and the startup notice tells you so. With «solo» ("on its own") and the permission installed on your machine, it catches
  up without a password, only with the published and verified version (below, «Update it without a password»). That
  adopts the published brake without a person at the
  keyboard.
- **Codex** does not read Claude Code's managed configuration: on that side the brake also stops
  the gate and asks you to run the statement yourself. What it does not cover is declared in
  `guides/maintaining/codex-divergence-inventory.md`, not promised.

And five more, specific to reading names the way the shell does:

- **A name that a program computes without its text being in view is not seen.** For example
  `rm $(cat lista)`, or a `while read` that deletes what reaches it through the pipe. The barrier there is that
  production is sticky: deleting the index does not lower any production server.
- **A script written in an earlier command and run later with a shell** (`bash /tmp/guion.sh`) is
  read to look for servers, not writes. Closing that is left for a separate story.
- **Deleting or moving a folder that contains the protected ones from higher up** (`rm -rf ~/.claude`,
  moving a whole repo) is not stopped. The brake protects its files, not everything that contains them.
- **Until each machine reinstalls, the installed brake keeps the holes.** What runs is the
  copy in `/opt/tycon`, and it changes only when reinstalling with `sudo`. The startup notice says so, also
  when only a library the brake uses changes.
- **If the brake is badly installed** (root's interpreter or the brake is missing, or their data does not match),
  **it decides with its emergency criterion**, which only checks whether the command names databases or the Keychain.
  That criterion does not recognize most of these forms, and the command passes. It is not widened: widening it stopped
  11 of the last 4,000 real commands, which touched nothing. Stopping everything there would leave the machine without a
  terminal until reinstalling.
- **If the brake does not answer in time, or crashes with an error of its own, it stops EVERY command**, whether it names
  databases or not: the brake also judges what a command runs inside (a script, `bash -c`, a heredoc), and
  the launcher does not see that. The launcher has a 7 s clock for all its work, and the hook has a
  30 s cap in the managed configuration: more than double, so that the launcher always answers
  first.
- 🔴 **If the launcher does not answer within 30 s, is killed or does not start, the command does not run.** Valid since
  Claude Code 2.1.295: the console hook carries `"onFailure": "block"` in the managed configuration.
  With an earlier version the option does nothing: Claude Code cuts the launcher and the command runs anyway.
  Each cut is counted: the nightly review of the runs counts each hook that ran over time.
- 🔴 **In Codex the brake runs without the launcher and without `onFailure`.** Codex calls the brake directly
  (`node …/prod-access-guard.js`), without the launcher's 7 s clock, and it has no option to block when the hook
  fails. If the brake crashes or hangs, the command runs. In Claude Code that same failure blocks.
- **A hung brake is not cut from inside.** The brake's own clock does not interrupt a regular expression or an
  analysis that has already started. In Claude Code the hook's cap with `onFailure: block` catches it; in Codex, nothing.
  The brake's expressions that grew with the square of the command's length no longer do: with the whole brake, a
  hostile 200 KB word takes 63 ms. If a new expression turns slow, only that cap catches it.
- **If the launcher is missing, no agent console command runs, and the agent cannot fix it.**
  A person gets out of it, from their terminal and with `sudo`: they reinstall the brake
  (`sudo bash ~/.tycon/harness/scripts/production/install-guard.sh`) or remove the managed file
  (`sudo rm "/Library/Application Support/ClaudeCode/managed-settings.d/tycon-production.json"`), which leaves
  the machine without this brake until it is reinstalled.

## Before installing on a machine: measure how much it would stop

```bash
node ~/.claude/tycon-harness/scripts/production/measure-guard.js 4000
```

It passes that machine's last 4,000 real commands through the brake and counts how many it stops, separating
those that name databases or the Keychain from those that do **not**. **Threshold: 0 stopped that do not name databases.**
If it gives more, it is not installed: it is a false positive of the brake and gets fixed first, because a brake that
stops normal work ends up being turned off. It does not print any command.

Measured on 2026-09-15: the first version, with all its tests green, stopped
**313 of 4,000 (7.8 %)** commands that touched no database; after the fix, **0**. The ones it does
stop are commands that name servers the machine has not declared yet — that is why, before
installing, it is a good idea to declare the test servers in use (for example `acme-test.example.com`).

## When something is stopped and you think it should not be

The message says the reason and the right path. The two normal cases:

- **«no está declarado»** ("it is not declared") → it is a test server: declare it in the `.tycon/production.json` of
  the repo that uses it.
- **«está declarado como producción»** ("it is declared as production") → use the gate. If it really stopped being
  production, `--reclassify`.
- **«no encontré el snapshot de shell de esta sesión»** ("I did not find this session's shell snapshot") → that machine
  has the brake from before 2026-09-16 installed. Claude Code 2.1.272 (the VS Code extension) no longer writes that
  snapshot, and the current brake, without a snapshot, asks the live login shell. Run the installer
  (`scripts/production/install-guard.command`, it asks for `sudo`) and try again.
- **«no pude saber cuándo arrancó esta sesión para elegir su snapshot de shell»** ("I could not tell when this session
  started to pick its shell snapshot") → that machine has the brake from before 2026-11-27 installed. It happened to a
  long, resumed session, and to any session with the terminal language (`LANG`) in Spanish in January, April, August and
  December. The current brake understands the time in any language and recognizes the resumed session; if it still does
  not know when it started, it checks all the snapshots and asks the login shell, instead of closing the gate. Run the
  installer (`scripts/production/install-guard.command`, it asks for `sudo`); meanwhile, a new session usually unblocks it.
- **«el snapshot de shell … define … y no pude saber cuándo arrancó esta sesión»** ("the shell snapshot … defines …
  and I could not tell when this session started") → a snapshot from an old session defines a name that would take
  over the gate, and the brake cannot rule out that it belongs to this session. Delete that snapshot (the path is in
  the message) if you know it is old, or open a new session.
- **«el freno no pudo decidir»** ("the brake could not decide") → the brake does not answer in time (or crashed) and so
  it stops, even a command that touches no database. It is usually the machine's load: retry in a moment. A record is
  left in `hook-errors.log`. If the notice asks you to reinstall, the installed brake is from before the interpreter's
  data was recorded and reads it whole on each command: reinstalling
  (`scripts/production/install-guard.command`, it asks for `sudo`) brings that data and makes it fast.
- **«un nombre que el freno no sabe leer como el shell»** ("a name the brake cannot read the way the shell does") → the
  command writes into the protected folder in a form the brake cannot decide: an unclosed parenthesis, or a `setopt`
  before it. If you did not mean to touch a protected file, write the names in full, without braces or variables, and
  the brake will be able to read them.

If something unrelated to databases stops you, **it is our bug**: say so, because a
brake that bothers people for no reason is the one someone ends up turning off.

## For whoever maintains the harness

- The brake: `scripts/hooks/prod-access-guard.js` · the gate: `scripts/production/tycon-prod-sql`
- Startup notice and index: `scripts/hooks/production-notice.js` ·
  `scripts/production/production-index.js`
- Installer: `scripts/production/install-guard.sh` (+ the `.command`) · managed configuration:
  `scripts/production/managed-settings.tycon-production.json.template`. The team's organization comes
  from the harness configuration, which the assistant can write: that is why the **first
  install asks you to confirm by keyboard** the clone's remote and the organization, and pins them as root
  in `/opt/tycon/produccion/origen-de-confianza.json`; if the remote or the organization change later,
  the installer refuses and says so — if the change is yours, `--change-origin` (it asks again
  by keyboard). An unreadable `tycon.json` or profile stops it, naming the file, not as
  «sin organización» ("no organization"). **The official move to GitHub** asks for nothing: if what is pinned is the
  harness's Azure clone and what is being installed is the downloaded version of the GitHub repo declared in
  `scripts/production/origin-moves.json` (the file next to the installer, not the one in the folder being installed),
  the installer accepts it on its own and says «el arnés se mudó a GitHub: actualizo el origen fijado» ("the harness
  moved to GitHub: updating the pinned origin"). Any other change still asks for `--change-origin` and the keyboard.
- From a **downloaded version** (`~/.tycon/harness`, without git), the installer recomputes each file and the tree from
  disk, and asks GitHub whether that tree is the one for the commit the state records. That commit has to be **from
  main**: the tip, or an earlier one whose brake (the files copied to `/opt`) is byte for byte the tip's. In
  that case it installs and warns «hay una versión más nueva; actualizá cuando puedas» ("there is a newer version;
  update when you can"). It stops with a commit from a branch or a local change, with a brake that changed at the tip
  (an old version also verifies against GitHub, and the assistant can download it), and when GitHub does not answer or
  answers with an error, including the 403 from the rate limit. Until 2026-10-14 it required the exact tip, and a day
  with 30 releases made it impossible to install.
- What the startup notice compares against: in a clone, against what is published (`origin/main`) and its history. On a
  machine running a **downloaded version** (`~/.tycon/harness`, without git), against that version —its manifest— and
  against the record the installer leaves as root in `/opt/tycon/production/installed-files.json`: equal to the running
  version, up to date; different but equal to the record, «quedó viejo» ("out of date"); different from both,
  «alguien lo cambió» ("someone changed it"). Never against the clone the machine keeps, which does not carry the same
  bytes as the downloaded version. A brake installed before the record does not have it: on a mismatch it says
  «quedó viejo», and reinstalling writes it.
- **Its own copy** (since 2026-10-14): the brake is not installed with the harness's shared libraries (the repos
  root, the configuration, where each thing lives…), which change almost every day for reasons unrelated to the brake and
  made it ask for the Mac password on every version. It is installed with its copy, `scripts/production/guard-libs/`,
  and the notice compares only that and the brake's pieces: a change in the rest of the harness no longer asks for a
  reinstall. The copy is updated deliberately: `node scripts/production/guard-libs-check.js` (run by
  `install-guard.test.sh`, T34) stops when a shared one changed in something the brake uses and nobody decided it, says
  what differs, and offers `refresh` (the copy becomes the shared one; the brake changes and each machine reinstalls
  once) or `keep` (the copy stays; it is recorded that someone looked). What differs only in what the brake does not
  use is reported and does not stop. A brake installed before its own copy asks for a reinstall one more time only, and
  that notice explains it.
- Safety net: `scripts/tests/prod-access-guard.test.sh`, `tycon-prod-sql.test.sh`, `install-guard.test.sh`
  and the bench cases `40-prod-access-guard.json` / `41-production-notice.json`.
- Help log: `~/.claude/.tycon-pipeline/production.log` (never the statement, only its fingerprint).

## What the brake does NOT let through even when hidden (since 2026-09-15)

A command can hide what it runs: `bash -c '…'`, `eval`, `python3 -c '…'`, a heredoc
body, or a script that the same command writes and runs. The brake looks **also inside those
texts** — otherwise, a `bash -c` reads the production password from the Keychain with nothing stopping it.
And when the command names databases and hides what it runs in a way that cannot be seen (for
example `bash -c "$CMD"`, with the variable defined elsewhere), **it stops and says so**.

What the command **only writes** to a file and does not run (`cat > server.js <<'EOF'`, `tee x <<EOF`) is content,
not something that runs: the brake does not read it looking for servers or the Keychain. This holds only if the whole
command uses `cat`, `tee`, `mkdir`, `touch`, `echo`, `printf`, `ls` or `true`, without `$(…)` or pipes to another
program, and the file has a fixed name, is created or overwritten (not appended to) and lives in your folder or in a
temporary one, outside hidden folders and `~/Library`. It cannot be named like a script something else runs (`*.sh`,
`*.bash`, `*.zsh`, `*.command`, `Makefile`, `package.json`, `Dockerfile`, upper or lower case); if
it already existed, it cannot be a link or have execute permission; and the command cannot assign variables (`PATH=…`).
With an unquoted `<<EOF` the shell runs the body's `$(…)`: that body is released only if it has no `$` or backticks
(with `<<'EOF'` nothing is expanded), and the delimiter is written plainly (`EOF`, `'EOF'` or `"EOF"`). On any doubt (a
denied permission, a relative path without the session's folder) it is judged as always. With anything else
(`node server.js`, `bash < x.sh`, `cat >> ~/.zshrc`) it is judged as always.

What is **not** stopped, on purpose, because it is everyday work: searching text (`grep`,
`cat`, `echo`), asking whether a client is installed (`command -v sqlcmd`), listing servers in
Azure without naming any, a routine `git merge`, or running a harness script that touches `.tycon/`.
Nor a `for` that names the gate among its words and only reads:
`for f in prod-access-guard tycon-prod-sql; do grep -rl "$f" scripts; done` passes. To pass, the whole command,
including what is inside each `$( … )`, has to be made of readers that do not run what they receive (`grep`, `cat`,
`printf`, `wc`, `head`…), written without a path. The words of the `for` have to be plain, and outside single
quotes there can be no parentheses, brackets or braces (outside the `$( … )`): zsh runs code with `*(e:…:)` and
`${(e)…}`. The `for` variable is short and lowercase (up to four characters, and not `path` or `argv`). There also
cannot be backticks, assignments, `printf` options or redirections that write (except to
`/dev/null`). With `"$f"`, `| sh`, `xargs`, `find`, `rg` or `sort` inside, it stops as before.
Measured on 4,000 real commands from the dev: **0 stopped that do not name databases**. The meter
(`node scripts/production/measure-guard.js`) counts separately what it **could not** measure —timeout or
crashed brake— and exits ≠ 0 if there are false positives or something unmeasured: «I could not measure it» is not
«it passed clean».

### Names are read the way the shell reads them

Comparing the command's text with the protected names —the catalog, the
index and the memory— is not enough. The shell transforms each word before running it, and
`rm -f ~/.claude/.tycon-pipeline/production-{index,memory}.json` would delete both files with nothing
stopping it. That is why the brake builds each name the way the shell will build it, and judges the result:

- **Braces and ranges**: lists, nested braces, `{h..j}`, `{01..10}`, `{,.bak}` and braces in a folder.
  In quotes, escaped or with a single element they stay literal, just as in the shell.
- **zsh forms**: the alternation `(index|memory)` expands like braces; `(N)` at the end is removed and
  `**/` counts as `*`. The extended glob operators (`^`, `~`, `@(…)`) turn the word into a wildcard.
- **Shell options**: a command with `setopt`, `shopt`, `emulate` or `set -o` changes how
  names are read, so whatever it names in the protected folder is treated as doubtful. `set -euo pipefail` and
  its relatives do not count: they do not change names.
- **`$'…'` quotes**: they are decoded before comparing; `$'production-\x69ndex.json'` is the index.
- **Variables, modifiers and arrays**: a variable the command itself defines is replaced by its
  value. One it does not define, a zsh modifier (`$F:s/X/x/`) or a `${…}` with an operator count as
  «anything». An array counts as all its elements.
- **Upper case**: `Production-Index.json` is the same file on the macOS disk, and counts the same.
- **All redirections**: `jq … 2>/dev/null > …/production-index.json` stops. Before, only
  the command's first redirection was checked.
- **The working folder**: it is changed by `cd`, `pushd`, `chdir` and `builtin cd`, with their options; it starts
  at the session's folder; `git -C` and `make -C` set it for their command. With `cd -` or a destination
  that cannot be read it becomes unknown, and then the catalog's bare name counts as protected.
- **`xargs`**: if an earlier command in the same pipeline names a protected file or the protected
  folder, the program `xargs` runs counts as a write on it. A reader (`cat`, `jq`) passes. An
  interpreter (`python3`, `node`…) stops even if its program only reads, because it runs code the brake does not see
  (`python3 -c` loads a `json.py` from the folder before the real one); the reason does not say it writes: it says
  it cannot guarantee it only reads, and suggests `jq` or the reading tool.
- **`find`** that deletes (`-delete`) or runs a program that writes: since it goes down into subfolders, it is judged
  when it starts in the protected folder, in one that contains it (`~`, `~/.claude`, a repo) or in an
  unknown one. To know whether a folder contains repos with a catalog it looks at up to 5,000 subfolders; with more, or
  if it cannot read it, it stops as «un nombre que el freno no sabe leer como el shell» ("a name the brake cannot read
  the way the shell does").
- **Substitutions**: a `$(…)` in the arguments of a program that writes stops if its text names the
  protected folder.
- **`for` loops**: the words of `for f in <palabras>` are not written; they go into the variable and are judged where
  they are used. `for f in $(ls ~/.claude/.tycon-pipeline/*.json); do cat "$f"; done` passes; with `rm "$f"` inside, it stops.
- **Wildcards and hidden folders**: as in the shell, a wildcard that does not start with a dot (`*-*`, `$ID-*`) does not
  match a folder that starts with a dot; it is not taken as the protected folder. If the command changes that
  rule (`setopt globdots`, `shopt -s dotglob`), what is left in scope is undecidable.
- **Interpreters**: an unresolved variable passed as data to `python3`, `node` and the like is treated as
  the program's data, as before; what stops is the protected name written out or a substitution that names it.

**The protected folder**, for all of this, is the root of `~/.claude/.tycon-pipeline/` or the `.tycon/`
folder of a repo, plus any name that starts with `production` or `produccion`, case
insensitive. The pipeline's subfolders (`timing-history/`, `corridas-buzon/`…) are not: that is where
almost all the measured false stops were. What the brake cannot read **inside** that scope
stops, with its own reason. **Outside**, it does not: `mkdir -p src/{a,b}` and `rm -rf "$TMP"/*` still pass. What
does not write is not stopped either: an `echo` that names the index passes.

**The measurement.** Before the fix, 119 shell forms were measured, with real zsh and bash: 65 did not do
what they were supposed to do. Of those, 59 passed while touching a protected file and 6 stopped without touching anything.
The 119 are now a test (`scripts/tests/prod-guard-shell-forms.test.sh`), and 29 of them are bench
cases. The usual threshold does not change: 0 stopped that do not name databases over the last 4,000
real commands.

## The Keychain key: how it must be loaded

The loading is done by the `.command` the gate leaves on the Desktop, and that is fine. If someone
loads the entry **by hand with `-A`**, any program of the user can read the password without a
box — and the gate **refuses to use it** and tells you to delete it and load it again. To
check it: `tycon-prod-sql --verify` says, key by key, who can read it (and now **exits
≠ 0** if something is wrong, so it can be called from a script).

The password never travels in a command's arguments: it would go to the process list, visible
to any program of the same user while it lasts. It goes through standard input.

## «Login failed» with the key loaded correctly: do not reload it, check the client config

🔴 **If the server rejects a freshly loaded key, it may not be the key.** The client the gate uses (`go-sqlcmd`) reads
`~/.sqlcmd/sqlconfig`, and if there is a **current context with a saved user there, it sends the server the
key saved there and ignores `SQLCMDPASSWORD`**, even when it receives explicit `-S` and `-U`. An old
config with the key saved wrong always gives «Login failed».

It was measured with a **fake SQL server** on the machine itself that decodes the user and the
key from the login packet (`scripts/tests/lib/tds-spy.py`): with the config present the client
sent the old key; without it, the variable's; with `-P`, the argument's. That is why the
gate runs the client with `HOME` in an empty folder —it does not see any user config— and
`--verify` says whether that config exists. Case T32 of `scripts/tests/tycon-prod-sql.test.sh`, with
the real client and its control.

The rule: **a «Login failed» with `--verify` green is NOT a badly loaded key.**
Before asking someone to delete and reload the entry, you have to know which key really
traveled.
