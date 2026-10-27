# door

`cophyla-door`, the **CophylaDoor** Windows service: what keeps a machine reachable through
Cophyla while Windows sits at its sign-in or lock screen and its user's own cophylad is not
running. The service is a small Rust shim. It supervises a Bun child, cophylad's
`main.ts door`, run from a copy of the user's platform version, and tells it the console's
state and the power line. It holds a power request while the child says so. It also bridges
the named pipe `\\.\pipe\cophyla-door`, which the user's daemon attaches to whenever it runs.
The same binary installs the service, removes it and reports on it. The shim is native because
it must start before any user does, stay small while it waits, and outlive every child it
runs.

Windows only. On macOS and Linux the binary says so and exits 2; its logic (arguments, the
protocols, the console and power rules, the supervisor, the SDDL, the layout) is
platform-free and tested on all three.

## Modes

| | |
|---|---|
| `cophyla-door service` | What the SCM runs, as `NT SERVICE\CophylaDoor`. Takes STOP, SHUTDOWN, SESSIONCHANGE and POWEREVENT. Logs to `shim.log` in the data root. |
| `cophyla-door run --console [--home <dir>] [--program <dir>] [--data <dir>] [--pipe <name>] [--user-sid <sid>] [--bun <path>] [--main <path>] [--no-power]` | The same machinery without the SCM, for development and test kits. Logs to stderr. |
| `cophyla-door install --from <versionDir> --user-sid <sid> [--result <file>]` | Elevated, once. Makes the machine's door from a user's installed platform version. |
| `cophyla-door uninstall [--result <file>]` | Elevated. Removes all of it. |
| `cophyla-door status` | No elevation. One JSON line: `{"installed":bool,"state":"running"\|"stopped"\|"start_pending"\|…,"pid":n?,"version":"<current>"?,"shim":"<crate version>"}`. A service that is not installed reads `stopped`. |

In the console mode, stdin drives what the service learns from Windows. It takes `signin`,
`locked`, `active`, `ac on` and `ac off`, and `stop`, a graceful stop followed by exit 0. The
end of stdin is a stop too. The door starts `active` and on AC. `--user-sid` defaults to the
user running the shim. `--data` defaults to `%ProgramData%\Cophyla Door`, `--home` to
`<data>\home`, and `--program` to `%ProgramFiles%\Cophyla Door\program`; kits pass temporary
folders. `--bun` and `--main` override the child's command: a bare `--bun bun` is found on the
shim's own PATH, since the child's PATH is the system's alone. `--no-power` logs power requests
instead of making them.

`install` and `uninstall` run through ShellExecuteEx `runas`, whose caller cannot see stdout.
Their outcome goes to `--result` as `{"ok":true,"version":"<v>"}` (an uninstall has no
version) or `{"ok":false,"error":"…"}`. The file is written beside the path and renamed over it,
so the caller never reads half of one and a link planted at the path is replaced, not
followed. Exit codes: 0 done, 1 failed, 2 bad arguments, 5 not elevated.

## Folders

```
%ProgramFiles%\Cophyla Door\           administrators only (Program Files' own ACL)
  cophyla-door.exe                     the SCM's image
  cophyla-door-THIRD-PARTY-LICENSES.html   when the release staged it beside the exe
  program\                             inherited ACL plus the service's Modify
    versions\<v>\                      bun.exe, release.json, cophylad\… (no models, views or phone app)
      .broken                          a version the shim gave up on
    current, previous                  one version on one line each, as the launcher's
    bin\cophyla-net.exe                fixed; the firewall rule names it
    moonlight-web\                     protected: SYSTEM, Administrators, the service; no Users
      streamer.exe                     filled by the child; the firewall rule names it
      server\                          the web viewer's pairing with the desktop host (a client key)
%ProgramData%\Cophyla Door\            the data root, protected: SYSTEM F, Administrators F, the service M
  door.json                            {"v":1,"userSid":"S-1-5-21-…","version":"<v>","installedAt":<ms>}
  install.log, shim.log, child.log     each about 5 MB at most, rotated to <name>.1
  home\                                the child's --home; tmp\, bun-cache\ and appdata\ made by the shim
```

## The install

`install --from <versionDir> --user-sid <sid>` takes a user's platform version folder, named
for its version: `bun.exe`, `release.json`, `bin\cophyla-net.exe`, and cophylad's tree with
its `node_modules`. In order, logged to `install.log`:

1. It checks elevation (exit 5) and the arguments and files (exit 2).
2. It takes the data root as its own or refuses it. A folder already there must be a plain
   folder (no link) owned by SYSTEM or Administrators; a missing one is created with SYSTEM
   and Administrators alone from its first moment. The log goes there from then on; nothing
   is written into a folder that is refused.
3. It stops a running CophylaDoor and waits up to 20 s, ending its process if it has to.
4. With the service stopped, it removes any link or junction under `program\` and the data
   root. The service account can write there, and could have planted one to point an
   administrator's copy or ACL change somewhere else.
5. It copies itself (and the licences beside it) to `%ProgramFiles%\Cophyla Door`; a file
   still in use is moved aside first. It copies `bun.exe`, `release.json` and cophylad's tree
   to `program\versions\<v>`, replacing what was there; the tree leaves out
   `apps\cophylad\models`, `apps\cophylad\views` and `apps\controller` and follows no links.
   It copies `bin\cophyla-net.exe` to `program\bin`, then writes `current`.
6. It creates the service or updates its configuration: auto start, the binary
   `"<ProgramFiles>\Cophyla Door\cophyla-door.exe" service`, the virtual account
   `NT SERVICE\CophylaDoor` with no password, a description, restarts after 5 s, 30 s and
   60 s (failures counted afresh after a day, and a stop with an error counting as one),
   SeChangeNotifyPrivilege as its only privilege, and an unrestricted service SID.
7. It sets the ACLs: the service gets Modify on `program\` through icacls. `moonlight-web\`
   is created, or re-protected, with SYSTEM, Administrators and the service only. The data
   root gets its protected DACL with the service's SID, carried down to everything in it.
8. It writes `door.json` and replaces the two inbound UDP firewall rules through netsh,
   deleting each by name and adding it again for any profile: `Cophyla Door streamer` for
   `moonlight-web\streamer.exe` and `Cophyla Door net` for `bin\cophyla-net.exe`.
9. It starts the service and waits up to 15 s for it to run.

The uninstall stops and deletes the service and deletes both rules. It deletes the data root
first, since it holds the door's secrets, removing links rather than following them. Then it
deletes `%ProgramFiles%\Cophyla Door`. Run from inside that folder, it deletes everything
else and leaves a detached `cmd /c` to remove the folder a few seconds after it exits.

## The child

```
<program>\versions\<cur>\bun.exe <program>\versions\<cur>\cophylad\apps\cophylad\src\main.ts door --home <home> --program <program>
```

or `--bun`/`--main` in a console. The child starts with no window, its stdio piped and its
home as its folder. It gets a cleared environment holding only `SystemRoot`, `windir`,
`SystemDrive`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`, `COMPUTERNAME`,
`NUMBER_OF_PROCESSORS` and `PROCESSOR_ARCHITECTURE`. PATH is
`%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\WindowsPowerShell\v1.0`. `TEMP` and
`TMP` are `<home>\tmp`, `USERPROFILE` is `<home>`, `LOCALAPPDATA` is `<home>\appdata`,
`BUN_INSTALL_CACHE_DIR` is `<home>\bun-cache`, and `COPHYLA_DOOR` is `1`. The child runs in a
job object that kills whatever it started when the job closes. A streamer or a helper it ran
therefore never outlives it, nor the shim. Its stderr goes to `child.log` (the console mode's
stderr).

The two speak newline-delimited JSON-RPC 2.0 notifications on stdio, with no ids, UTF-8 and
one object per line.

Shim to child:

| | |
|---|---|
| `shim.hello {protocol: 1, version, console, ac, userSid}` | The first line after a spawn. |
| `console.state {console}` | `signin`, `locked` or `active`, on every change. |
| `power.state {ac}` | On every change. |
| `pipe.open {conn, sid}` | A client of the door's user attached. |
| `pipe.line {conn, line}` | A line it wrote, without its line break (a CR before the LF is dropped too; empty lines are skipped). |
| `pipe.close {conn}` | It went, or was dropped (also after a `pipe.drop`). |
| `shim.stop {}` | The door is stopping: exit 0 within STOP_GRACE_MS (10 s), or be killed. |

Child to shim:

| | |
|---|---|
| `pipe.send {conn, line}` | Write `line` and a newline to that client. A line holding a line break is refused, since it would be two. |
| `pipe.drop {conn}` | Close that client once what was queued for it is written. |
| `power.want {ready, streaming}` | The child's inputs to the power rule. |

Unknown methods are logged and ignored. A stdout line that is not JSON goes to `shim.log`.

**The supervisor.** Before each spawn the shim reads `current`. A missing pointer, or a version
without `bun.exe` or `main.ts`, is looked for again every 60 s, so a half-done install
recovers. Exit code 75 (EXIT_UPDATED) means the child made a new version current: it starts
again at once. Anything else is a crash. A crashed child starts again after 1 s, the wait
doubling to 60 s and going back to 1 s once a child stayed up ten minutes. A version that
crashes 5 times (CRASH_LIMIT) within 300 s (CRASH_WINDOW_MS) of its first start in this
shim's life is given up, when `previous` names a different, complete version not marked
broken. Giving up marks it `.broken`, makes `previous` current and removes `previous`, as the
launcher's rollback does. When the child exits for any reason, every client is closed, so the
daemon attaches again to the next child, and the child's power wants are forgotten.

**The console.** Under the service the console's state comes from Terminal Services: the
session at the physical console (`WTSGetActiveConsoleSessionId`; none is `signin`), its user
name (none is `signin`) and its lock flag (`locked`; anything else is `active`). The shim asks
on every SESSIONCHANGE and, as a safety net, every 10 s. If Windows will not answer (a virtual
account may lack the right), the console counts as `active`, logged once. The door then never
serves wrongly; it only fails to serve.

**Power.** AC is `ACLineStatus` 1, or 255 (unknown) with no system battery. The shim reads it
again on a power status change and on the poll. The system is held awake, by a
system-required power request, while `streaming || (ready && console != active && ac)`: a
stream is never cut by sleep, and an idle door keeps a plugged-in machine reachable at its
sign-in screen without draining a battery. The request is let go on every stop.

## The pipe

`\\.\pipe\cophyla-door`: byte mode, 64 KiB buffers, remote clients rejected, at most four
instances. The first instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE: if someone
already holds the name, the shim logs it and exits with an error, and the SCM's failure
actions try again. From then on an instance is always listening, and the next one is made
before a connected one is handed on, so the name is never let go while the shim lives. With
three clients connected, a fourth is turned away.

**The client writes first.** Windows tells a server who a pipe client is only by impersonating
it, and refuses to impersonate one before the server has read something from it
(ERROR_CANNOT_IMPERSONATE). The shim therefore waits up to 10 s for a client's first bytes,
then reads its user and lets in only the door's user. Only then does it send `pipe.open`, with
the bytes it read following as the first `pipe.line`s. A client that writes nothing is closed.
The daemon should send its first line (a hello, an attach) as soon as it connects, and not wait
to be greeted.

Each client gets an increasing `conn`, a reader (a line over 1 MiB drops it) and a writer with
a bounded queue (a client that stops reading is dropped rather than waited on). A client that
connects while no child runs, or while the door stops, is closed at once. A client is closed
by closing the handle, so what was already written can still be read before the end.

## Security

The door serves a machine nobody is signed in to, so it is built to be no more powerful than
the user it serves and to talk to that user alone.

- **No SeImpersonate.** The service runs as its own virtual account with
  SeChangeNotifyPrivilege as its only privilege. Without SeImpersonatePrivilege, impersonating
  a pipe client yields only an identification-level token: enough to read who the client is,
  never enough to act as them. Neither the shim nor its child can borrow the identity of
  whoever connects, an administrator or SYSTEM included.
- **The pipe's ACL and the SID check.** The pipe's DACL is
  `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;<shim>)(A;;GRGW;;;<user>)`. Only SYSTEM,
  Administrators, the service's own account (which creates the later instances) and the
  door's user can open it, and nothing is inherited. That alone would let any administrator
  in, so every client is checked again by SID after it connects, and only the user named in
  `door.json` is let in. A client whose user cannot be read is refused. Note that
  GENERIC_WRITE carries FILE_CREATE_PIPE_INSTANCE, so the user could create an instance of
  the pipe; that lets the user's own processes stand in for the door to the user's daemon,
  which gains them nothing they did not have. The mask is left as it is because Node and Bun
  open pipes for GENERIC_READ | GENERIC_WRITE and would get a read-only pipe otherwise.
- **A protected data root.** `%ProgramData%\Cophyla Door` holds the door's secrets and its
  logs. Its DACL is protected (nothing inherited from ProgramData, which lets Users read and
  create) and names SYSTEM, Administrators and the service alone.
- **The squat check.** Any user may create a folder under `%ProgramData%`, so one could make
  `Cophyla Door` before the install, with a DACL of their own, and read what the door later
  keeps there. The install refuses a data root that is a link or is owned by anyone but
  SYSTEM or Administrators, and creates a missing one with its protected descriptor from its
  first moment, so there is no window under the inherited one.
- **The web viewer's folder.** `program\moonlight-web\` keeps the viewer's pairing with the
  desktop host: a client certificate and its key, which would let anyone who has them stream
  this desktop. Program Files lets Users read everything below it, so the install gives this
  folder a protected DACL with SYSTEM, Administrators and the service only. The rest of
  `program\` keeps the inherited ACL plus the service's Modify, and the SCM's image above it
  stays administrators' alone. The service can change what it runs, but not what the SCM
  starts.
- **Links.** The service account may write under `program\` and the data root. An install
  run by an administrator first removes any link or junction there, copies no links, and
  writes `door.json`, the pointers and the result file by renaming a new file into place.
  The service cannot point an administrator's write, copy or ACL change at another folder.
- **A cleared environment** for the child, and an elevated install that runs `icacls`,
  `netsh`, `cmd` and `ping` by their full System32 paths, never from PATH.

## Development

```
cargo test -j 8                                      unit tests everywhere; on Windows also tests/console.rs
cargo clippy --all-targets -j 8 -- -D warnings
cargo deny check
cargo about generate about.hbs -o THIRD-PARTY-LICENSES.html   after any Cargo.lock change
```

`tests/console.rs` runs the built shim in its console mode against temporary folders and a
pipe name of its own, with `examples/door-echo` as the child. That stand-in speaks the
protocol and echoes what a client writes. The test drives a line from a pipe client through
the shim to the child and back, the console's state from stdin to the child, an update exit,
a crash, a dropped client, power wants, a refused client of another user, a line too long, a
silent client, a taken pipe name, a door with no version to run, and a stop. The example is
built by a whole `cargo test`; `cargo test --test console` alone does not build it. The
service mode, the install and the uninstall need elevation and a real SCM, and have no
automated test.

A kit against the real child runs the console mode with the repo's Bun and cophylad's entry
point:

```
cophyla-door run --console --data <tmp>\data --home <tmp>\home --program <tmp>\program --pipe \\.\pipe\cophyla-door-kit --bun bun --main apps\cophylad\src\main.ts --no-power
```

The release stages `cophyla-door.exe` with `THIRD-PARTY-LICENSES.html` beside it as
`cophyla-door-THIRD-PARTY-LICENSES.html`, which the install copies beside the service's image.
The names and numbers shared with cophylad live in `src/constants.rs`, one per line, pinned by
a TypeScript test that reads that file.
