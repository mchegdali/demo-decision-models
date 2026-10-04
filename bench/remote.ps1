<#
.SYNOPSIS
  Benchmarks a decision model on a remote Ollama server (a rented GPU pod) instead of a local
  wslc container.

.DESCRIPTION
  The pod is created and deleted outside this script (RunPod); it must already run
  ollama/ollama with port 11434 reachable at -OllamaUrl.

  Pulls the weights first (not timed, like containers.ps1 -Action pull), measures the network
  round trip (p50 of 20 GET /api/version, reported with the run since every latency includes it),
  times the first /v1/systemone answer (cold start = weight load + first decision), then runs
  bench/run.ts with memory read from the server's /api/ps.

.EXAMPLE
  ./bench/remote.ps1 -Label clef-ollama-gpu-24gb -OllamaUrl http://1.2.3.4:40123 `
    -ModelId clef:27b-q4_k_m -Gpu "RTX 4090 24GB"
#>
param(
  [Parameter(Mandatory)][string]$Label,
  [Parameter(Mandatory)][string]$OllamaUrl,
  [Parameter(Mandatory)][string]$ModelId,
  [Parameter(Mandatory)][string]$Gpu,
  [string]$ServerNotes = "ollama/ollama:0.35.1 OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=-1",
  [int]$Limit = 0,
  [string]$Tasks = "",
  [int]$ReadyTimeoutSec = 1800
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$OllamaUrl = $OllamaUrl.TrimEnd("/")
$BaseUrl = "$OllamaUrl/v1"

function Wait-Server {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalSeconds -lt $ReadyTimeoutSec) {
    try { $null = Invoke-RestMethod -Uri "$OllamaUrl/api/version" -TimeoutSec 10; return } catch { Start-Sleep -Seconds 5 }
  }
  throw "$Label : Ollama at $OllamaUrl not reachable within $ReadyTimeoutSec s"
}

function Measure-RoundTrip {
  $times = foreach ($i in 1..20) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $null = Invoke-RestMethod -Uri "$OllamaUrl/api/version" -TimeoutSec 10
    $clock.ElapsedMilliseconds
  }
  ($times | Sort-Object)[10]
}

function Wait-FirstDecision {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $body = @{ model = $ModelId; state = "hello"; questions = @{ greeting = @{ type = "noul"; instructions = "Is this a greeting?" } } } | ConvertTo-Json -Depth 5
  while ($clock.Elapsed.TotalSeconds -lt $ReadyTimeoutSec) {
    try {
      $null = Invoke-RestMethod -Method Post -Uri "$BaseUrl/systemone" -ContentType "application/json" -Body $body -TimeoutSec 600
      return $clock.ElapsedMilliseconds
    } catch { Start-Sleep -Milliseconds 1000 }
  }
  throw "$Label gave no decision within $ReadyTimeoutSec s"
}

try {
  Wait-Server
  "[$Label] pulling $ModelId on $OllamaUrl"
  $pull = [Diagnostics.Stopwatch]::StartNew()
  $null = Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/pull" -ContentType "application/json" `
    -Body (@{ model = $ModelId; stream = $false } | ConvertTo-Json) -TimeoutSec 3600
  "[$Label] pulled in $([int]$pull.Elapsed.TotalSeconds) s"
  $rtt = Measure-RoundTrip
  "[$Label] network round trip p50: $rtt ms"
  $coldStart = Wait-FirstDecision
  "[$Label] cold start: $coldStart ms"
  $nodeArgs = @("--env-file-if-exists=$Root\.env", "$Root\bench\run.ts", "--label", $Label, "--base-url", $BaseUrl,
    "--model-id", $ModelId, "--device", "gpu", "--container", "runpod", "--ollama-url", $OllamaUrl,
    "--cold-start-ms", $coldStart, "--baseline-vram-mib", "0",
    "--notes", "$ServerNotes RunPod $Gpu, network RTT p50 $rtt ms")
  if ($Limit -gt 0) { $nodeArgs += @("--limit", $Limit) }
  if ($Tasks) { $nodeArgs += @("--tasks", $Tasks) }
  node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "bench/run.ts failed for $Label" }
  Remove-Item "$Root\bench\results\$Label.failed.json" -ErrorAction SilentlyContinue
} catch {
  New-Item -ItemType Directory -Force "$Root\bench\results" | Out-Null
  @{ label = $Label; device = "gpu"; reason = "$_".Trim() } |
    ConvertTo-Json | Set-Content -Encoding utf8 "$Root\bench\results\$Label.failed.json"
  throw
}
