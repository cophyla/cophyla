# Spike 14: what the two installers left behind. Read-only; run after install.md.
$ErrorActionPreference = "Continue"

"== Apollo / Sunshine binaries"
foreach ($p in @("$env:ProgramFiles\Apollo\Apollo.exe", "$env:ProgramFiles\Apollo\sunshine.exe",
                 "$env:ProgramFiles\Sunshine\sunshine.exe")) {
  if (Test-Path $p) { "  $p  $((Get-Item $p).VersionInfo.FileVersion)" }
}
if (Test-Path "$env:ProgramFiles\Apollo") { Get-ChildItem "$env:ProgramFiles\Apollo" | Select-Object -ExpandProperty Name | ForEach-Object { "  - $_" } }

"== Services"
Get-Service | Where-Object { $_.Name -match 'apollo|sunshine' } | ForEach-Object {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($_.Name)'"
  "  $($_.Name) [$($_.Status)] start=$($svc.StartMode) path=$($svc.PathName)"
}

"== Config directories"
foreach ($d in @("$env:ProgramFiles\Apollo\config", "$env:ProgramData\Apollo", "$env:ProgramData\Sunshine",
                 "$env:ProgramFiles\Sunshine\config", "$env:APPDATA\Apollo", "$env:LOCALAPPDATA\Apollo")) {
  if (Test-Path $d) { "  $d"; Get-ChildItem $d -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | ForEach-Object { "    - $_" } }
}

"== Listening ports (Apollo/Sunshine range)"
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 47980 -and $_.LocalPort -le 48020 } |
  ForEach-Object { $proc = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; "  tcp $($_.LocalAddress):$($_.LocalPort)  $proc" }
Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 47980 -and $_.LocalPort -le 48020 } |
  ForEach-Object { $proc = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; "  udp $($_.LocalAddress):$($_.LocalPort)  $proc" }

"== --creds / --help"
$exe = @("$env:ProgramFiles\Apollo\Apollo.exe", "$env:ProgramFiles\Apollo\sunshine.exe", "$env:ProgramFiles\Sunshine\sunshine.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($exe) { "  $exe --help:"; & $exe --help 2>&1 | Select-Object -First 25 | ForEach-Object { "    $_" } }

"== Display adapters after SudoVDA"
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Format-Table Status,FriendlyName,InstanceId -AutoSize | Out-String | ForEach-Object { $_.TrimEnd() }
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "  $($_.DeviceName) $($_.Bounds) primary=$($_.Primary)" }

"== Moonlight"
foreach ($p in @("$env:ProgramFiles\Moonlight Game Streaming Project\Moonlight\Moonlight.exe",
                 "${env:ProgramFiles(x86)}\Moonlight Game Streaming Project\Moonlight\Moonlight.exe")) {
  if (Test-Path $p) { "  $p  $((Get-Item $p).VersionInfo.FileVersion)"; & $p --help 2>&1 | Select-Object -First 20 | ForEach-Object { "    $_" } }
}
"  moonlight-qt state: $env:APPDATA\Moonlight Game Streaming Project\Moonlight.ini"
if (Test-Path "$env:APPDATA\Moonlight Game Streaming Project\Moonlight.ini") { "    exists" }

"== Firewall rules"
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'apollo|sunshine|moonlight' } |
  ForEach-Object { "  $($_.DisplayName) [$($_.Direction) $($_.Action) enabled=$($_.Enabled)]" }
