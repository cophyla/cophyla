# Named pipes whose name mentions codex, plus TCP listeners owned by codex.exe processes.
Get-ChildItem '\\.\pipe\' | Where-Object { $_.Name -match 'codex|app-server' } | ForEach-Object { "pipe $($_.Name)" }
Get-CimInstance Win32_Process -Filter "Name='codex.exe'" | ForEach-Object {
  $p = $_.ProcessId
  Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { "listen pid=$p $($_.LocalAddress):$($_.LocalPort)" }
}
