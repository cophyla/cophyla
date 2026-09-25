# Spike 14: what the host and the viewer cost while a stream runs (or idle, for the baseline).
# % of one core for sunshine.exe (the Apollo service) and Moonlight.exe, then the busiest GPU engines.
param([int]$Seconds = 10)
$cores = [Environment]::ProcessorCount
$paths = @('\Process(sunshine)\% Processor Time', '\Process(Moonlight)\% Processor Time', '\Process(web-server)\% Processor Time', '\Process(streamer)\% Processor Time', '\Processor(_Total)\% Processor Time')
$samples = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples $Seconds -ErrorAction SilentlyContinue
$byName = @{}
foreach ($s in $samples) {
  foreach ($c in $s.CounterSamples) {
    $name = ($c.Path -replace '.*\\process\(([^)]+)\).*', '$1') -replace '.*\\processor\(_total\).*', 'machine (all cores)'
    if (-not $byName[$name]) { $byName[$name] = @() }
    $byName[$name] += $c.CookedValue
  }
}
foreach ($k in $byName.Keys) {
  $v = $byName[$k] | Measure-Object -Average -Maximum
  if ($k -eq 'machine (all cores)') { '{0}: {1:N1} % avg, {2:N1} % max' -f $k, $v.Average, $v.Maximum }
  else { '{0}: {1:N1} % of one core avg, {2:N1} % max' -f $k, ($v.Average), ($v.Maximum) }
}
$gpu = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples |
  Where-Object CookedValue -gt 1 | Sort-Object CookedValue -Descending | Select-Object -First 6
foreach ($g in $gpu) {
  $p = [regex]::Match($g.InstanceName, 'pid_(\d+)').Groups[1].Value
  $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  '  gpu {0} {1}: {2:N1} %' -f $n, ($g.InstanceName -replace '.*engtype_', ''), $g.CookedValue
}
