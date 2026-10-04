<#
.SYNOPSIS
  Runs several benchmark runs back to back; one failure doesn't stop the queue.

.EXAMPLE
  ./bench/queue.ps1 laya-cpu kev-4b-gpu nimble-cpu:25
  (`run:N` caps that run at N items per task and language.)
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Runs)

foreach ($entry in $Runs) {
  $run, $limit = $entry -split ":"
  $log = Join-Path $PSScriptRoot "logs\run-$run.log"
  $started = Get-Date
  "[$($started.ToString('HH:mm:ss'))] $run$(if ($limit) { " (limit $limit)" })"
  try {
    & (Join-Path $PSScriptRoot "containers.ps1") -Run $run -Action bench -Limit $(if ($limit) { [int]$limit } else { 0 }) *> $log
    "  ok in $([int]((Get-Date) - $started).TotalMinutes) min"
  } catch {
    "  FAILED: $($_.Exception.Message.Split("`n")[0])"
  }
}
"queue done"
