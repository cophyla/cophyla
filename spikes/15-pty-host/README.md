# Spike 15: a PTY host that types into Claude Code as the user

Date: 2026-09-23. Windows 11 (build 26200), Claude Code 2.1.280, Rust 1.98.1, Bun 1.3.14,
`portable-pty` 0.9.0, `vt100` 0.16.2. Covers the open questions of
the PTY host proposal.

The session was an interactive `claude --model haiku` under the account's profile, working in
`C:\D\scratch-pty\work`. It ran with `--settings '{"disableAllHooks":true,
"showClearContextOnPlanAccept":true}'`, so that no running daemon held its plan dialog and the
clear-context row was shown.

**Verdict: works.**
- Text typed through a PTY the host owns is a turn the user typed.
- `/clear` typed that way clears the context.
- The CLI's own "Yes, clear context" row, pressed by key, builds the plan in the same terminal.
- A session starts and runs with no window attached, and windows attach, detach and reattach.

Keys typed by hand through the attach client are not checked yet.

## What is here

- **`src/main.rs`:** one binary, two halves.
  - `ptyhost serve` holds sessions in ConPTY. Each session has a `vt100` screen model fed from
    the same output bytes, and the host takes JSON-line requests: `spawn`, `write`, `submit`,
    `screen`, `resize`, `list`, `kill`.
  - `ptyhost attach` is the thin client a terminal window runs. It puts the console in raw mode
    with VT input, passes output through, and sends resizes.
- **Transport:** TCP loopback with a token, not a named pipe.
- **`drive.ts`:** runs the tests below.
- **`attach-wt.ts`:** adds a Windows Terminal window on the running session.
- **`stop.ts`:** ends what `drive.ts` and `attach-wt.ts` started, by the pids in
  `out/pids.json`.

```
cargo build -j 12
bun drive.ts        # leaves the host, the session and one window up
bun stop.ts
```

## Results

| # | Test | Result |
|---|---|---|
| A1 | Start a session with no window attached | It came up at the folder-trust dialog 0.6 s after spawn. The host answered the one terminal query of the start, a cursor-position request (`ESC[6n` → `ESC[1;1R`), from its screen model. |
| A2 | Answer the trust dialog through the host | The dialog has no numbered rows (`❯ No, exit` / `Yes, I trust this folder`, "Enter to confirm"). One Down arrow (`ESC[B`), checked on the screen model, then Enter. Registered 2.4 s after spawn. |
| B | Attach a window (`cmd /c start`, the default terminal) | Attached; the host resized the PTY to the window's 120×30. |
| C1 | Type a message with `submit` (bracketed paste, 300 ms, Enter) | Landed on the first Enter and answered in 2.2 s. **Stored as `origin: {kind: "human"}`, `promptSource: "typed"`, no `isMeta`**, exactly like the user's own typing. Over the messaging pipe the same text is `origin: {kind: "peer"}`, `isMeta: true`. |
| C2 | Type `/clear` | It ran: the registry's session id changed 0.6 s later. Asked for the code word from before, the model answered `NONE`. |
| D1 | Shift+Tab (`ESC[Z`) until plan mode, then ask for a one-line plan | Plan mode on; the plan dialog opened 5 s after the ask. |
| D2 | Press the clear-context row | Rows in 2.1.280: `1. Yes, clear context (6% used) and auto-accept edits` / `2. Yes, auto-accept edits` / `3. Yes, manually approve edits` / `4. Tell Claude what to change`. The digit selects and Enter confirms. The session id changed at once. Its first message is the CLI's own ("Implement the following plan: …", `origin: {kind: "auto-continuation"}`), in accept-edits mode. `hello.txt` was written without a prompt, **in the same terminal**. |
| E | Kill the window's client, then reattach from a classic `conhost` window | The host saw 0 clients, then 1. The new window got the repaint and the live stream. |

## Findings beyond the questions

- **Typed input carries the user's authority.** In the first run the message was "Remember
  the word PINEAPPLE". Typed, the model took it as the user asking to save a memory and wrote
  one, after the write was approved from the attached window. Sent over the pipe the same
  morning, the same sentence only got "OK".
- **A folder inside a git repository shares the repository's trust and project memory.**
  Claude Code keys both on the repository root. A session in `spikes/15-pty-host/out/work`
  needed no trust answer, and its memory was the orchestrator project's own. So the second run
  moved to `C:\D\scratch-pty\work`.
- **The plan dialog's fourth row** is "Tell Claude what to change" in 2.1.280, with
  "shift+tab to approve with this feedback". cophylad's own ask still says "No, keep planning".
- **`submit` needed no second Enter.** The 300 ms pause between the paste and Enter was
  enough on this machine.
- **The classic console window draws some of Claude's symbols as `?`.**
  - The bytes are right: the ConPTY output holds no replacement characters, and the screen
    model has every symbol.
  - But `conhost` draws with one font and no fallback. The console's default font (Cascadia
    Mono here) lacks 8 of the symbols the TUI drew in this session: `⎿ ⏵ ⏸ ✔ ✢ ✶ ✻ ✽`.
    Consolas lacks 15, adding `❯ ▔ ▛ ▜ ▝ ◉ ◐ ◯`.
  - A plain `claude` in the same window shows the same thing.
  - Windows Terminal falls back to other fonts. `attach-wt.ts` opens a Windows Terminal window
    on the running session for comparison.

## Not verified

- Keys typed by hand through the attach client: Shift+Tab, arrows, Esc, Ctrl+C, paste and
  resize.
- How the repaint looks after a long session. The screen model keeps no scrollback, so a
  reattached window starts at the last screenful.
- Windows 10 before build 22523, where the paste markers are stripped.
- Two windows attached at different sizes.
- A named pipe instead of TCP.
- The VS Code `Pseudoterminal` client.
- macOS and Linux.

## Left behind

- **Transcripts:**
  - under `~/.claude-accounts/other/projects/C--D-scratch-pty-work/`;
  - one from the first run under `…/C--D-orchestrator-spikes-15-pty-host-out-work/`.
- **Plan file:** `~/.claude-accounts/other/plans/make-a-plan-to-steady-aho.md`.
- **Trust entry:** `C:/D/scratch-pty/work` in that profile's `.claude.json`.
- **Scratch folder:** `C:\D\scratch-pty\` with `hello.txt`.
- **`out/`** (gitignored): `run1/`, `run2/`, and the third run's `run.log`, `host.log` and the
  raw output in `s1.raw`.
