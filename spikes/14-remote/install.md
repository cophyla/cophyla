# Spike 14 — installing the host and the viewer

Both installers elevate (Apollo installs a service and the SudoVDA virtual display driver;
Moonlight writes to Program Files), so they were run by hand in an elevated PowerShell rather
than by the spike. These are the exact commands, the same ones `apps/cophylad/src/remote/install.ts`
runs when `[remote] install = true`.

```powershell
winget install -e --id ClassicOldSong.Apollo --accept-package-agreements --accept-source-agreements
winget install -e --id MoonlightGameStreamingProject.Moonlight --accept-package-agreements --accept-source-agreements
```

Before the install this machine had: no Apollo, Sunshine or Moonlight; a `Meta Virtual Monitor`
display adapter (`ROOT\DISPLAY\0000`, driver 5.3.57.114, Quest Link) beside the RTX 4080; two
screens, `\\.\DISPLAY1` 1920×1200 primary and `\\.\DISPLAY2` 1536×864.

## What to record after the install

Filled in by `probe.ps1` (run it after both installs):

- Apollo: install path, service name and state, config directory, the API port and whether
  `Apollo.exe --creds` exists (Sunshine has `sunshine --creds <user> <pass>`).
- Moonlight: install path and the CLI verbs (`moonlight --help`).
- The Meta Virtual Monitor still `OK` after SudoVDA installed; SudoVDA's own device row.
- Firewall rules the installers added.
