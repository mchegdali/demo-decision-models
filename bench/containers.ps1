<#
.SYNOPSIS
  Starts, benchmarks and stops one decision-model server with wslc (WSL containers).

.DESCRIPTION
  wslc has no compose support, so each infra/*/compose.yaml service is translated here into
  one `wslc run`. wslc also lacks --read-only, --cap-drop and --security-opt, so these
  containers run without that hardening. They still run as non-root (except Ollama) and only
  publish on 127.0.0.1.

  bench: records baseline GPU memory, starts the server, times it until the first successful
  /v1/systemone answer (cold start = container start -> first decision, including weight load),
  runs bench/run.ts, then removes the container.

.EXAMPLE
  ./bench/containers.ps1 -Run clef-flash-ollama-gpu -Action bench
  ./bench/containers.ps1 -Run nimble-cpu -Action up
  ./bench/containers.ps1 -Run clef-flash-ollama-gpu -Action pull
  ./bench/containers.ps1 -List
#>
param(
  [string]$Run,
  [ValidateSet("up", "down", "bench", "pull")]
  [string]$Action = "bench",
  [int]$Limit = 0,
  [string]$Tasks = "",
  [int]$ReadyTimeoutSec = 1800,
  [switch]$List
)

$ErrorActionPreference = "Stop"
$Wslc = "C:\Program Files\WSL\wslc.exe"
$Root = Split-Path -Parent $PSScriptRoot
$CpuThreads = "8"   # physical cores of the bench machine; hyperthreads slow torch CPU inference down

$Laya = @{ Port = 8000; ContainerPort = 8000; Name = "laya"; Volume = $null }
$Kev = @{ Port = 8020; ContainerPort = 8000; Name = "kev"; Volume = "kev-weights:/models/hf" }
$Ollama = @{ Port = 11434; ContainerPort = 11434; Name = "ollama"; Volume = "ollama-models:/root/.ollama"; Image = "ollama/ollama:0.35.1" }

# One entry per benchmark run: server + device + the model id the client asks for.
$Runs = [ordered]@{
  "laya-gpu"              = $Laya + @{ Image = "test-typesafe-ai/laya:0.3.21-cu128"; Gpu = $true; ModelId = "convaiinnovations/laya"; Env = @{ LAYA_DEVICE = "cuda" } }
  "laya-cpu"              = $Laya + @{ Image = "test-typesafe-ai/laya:0.3.21-cpu"; Gpu = $false; ModelId = "convaiinnovations/laya"; Env = @{ LAYA_THREADS = $CpuThreads } }
  "laya-typed-gpu"        = $Laya + @{ Image = "test-typesafe-ai/laya:0.3.21-cu128"; Gpu = $true; ModelId = "convaiinnovations/laya-typed-decisions"; Env = @{ LAYA_DEVICE = "cuda" } }
  "laya-typed-cpu"        = $Laya + @{ Image = "test-typesafe-ai/laya:0.3.21-cpu"; Gpu = $false; ModelId = "convaiinnovations/laya-typed-decisions"; Env = @{ LAYA_THREADS = $CpuThreads } }
  # Kev: prefix cache off so repeated states don't flatter the numbers; CPU defaults to fp32,
  # which Kev-9B (36 GB) can't fit, so it runs in bf16.
  "kev-0.8b-gpu"          = $Kev + @{ Image = "test-typesafe-ai/kev:cu128"; Gpu = $true; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-0.8b"; KEV_PREFIX_CACHE = "0" } }
  "kev-0.8b-cpu"          = $Kev + @{ Image = "test-typesafe-ai/kev:cpu"; Gpu = $false; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-0.8b"; KEV_PREFIX_CACHE = "0"; OMP_NUM_THREADS = $CpuThreads } }
  "kev-4b-gpu"            = $Kev + @{ Image = "test-typesafe-ai/kev:cu128"; Gpu = $true; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-4b"; KEV_PREFIX_CACHE = "0" } }
  "kev-4b-cpu"            = $Kev + @{ Image = "test-typesafe-ai/kev:cpu"; Gpu = $false; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-4b"; KEV_PREFIX_CACHE = "0"; OMP_NUM_THREADS = $CpuThreads } }
  "kev-9b-gpu"            = $Kev + @{ Image = "test-typesafe-ai/kev:cu128"; Gpu = $true; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-9b"; KEV_PREFIX_CACHE = "0" } }
  "kev-9b-cpu"            = $Kev + @{ Image = "test-typesafe-ai/kev:cpu"; Gpu = $false; ModelId = "kev-latest"; Env = @{ KEV_RUN = "jaredpalmer/kev-9b"; KEV_PREFIX_CACHE = "0"; KEV_DTYPE = "bf16"; OMP_NUM_THREADS = $CpuThreads } }
  # Ollama library decision models (pull first with -Action pull); keep-alive -1 so Ollama never
  # unloads mid-run. The same weights run on both devices.
  "nimble-gpu"            = $Ollama + @{ Gpu = $true; ModelId = "nimble:9b-q4_K_M"; Env = @{ OLLAMA_KEEP_ALIVE = "-1" } }
  "nimble-cpu"            = $Ollama + @{ Gpu = $false; ModelId = "nimble:9b-q4_K_M"; Env = @{ OLLAMA_KEEP_ALIVE = "-1"; OLLAMA_NUM_THREAD = $CpuThreads } }
  # Clef-flash: q8_0 (~11 GB) is the smallest CUDA tag in the library.
  "clef-flash-ollama-gpu" = $Ollama + @{ Gpu = $true; ModelId = "clef-flash:9b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1" } }
  "clef-flash-ollama-cpu" = $Ollama + @{ Gpu = $false; ModelId = "clef-flash:9b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1"; OLLAMA_NUM_THREAD = $CpuThreads } }
  # Clef 27B: q4_k_m (~18 GB) doesn't fit 12 GB of VRAM; Ollama offloads the remaining layers to the CPU.
  "clef-ollama-gpu"       = $Ollama + @{ Gpu = $true; ModelId = "clef:27b-q4_k_m"; Env = @{ OLLAMA_KEEP_ALIVE = "-1" } }
  "clef-ollama-cpu"       = $Ollama + @{ Gpu = $false; ModelId = "clef:27b-q4_k_m"; Env = @{ OLLAMA_KEEP_ALIVE = "-1"; OLLAMA_NUM_THREAD = $CpuThreads } }
  "tev1-0.8b-gpu"         = $Ollama + @{ Gpu = $true; ModelId = "tev1:0.8b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1" } }
  "tev1-0.8b-cpu"         = $Ollama + @{ Gpu = $false; ModelId = "tev1:0.8b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1"; OLLAMA_NUM_THREAD = $CpuThreads } }
  "tev1-4b-gpu"           = $Ollama + @{ Gpu = $true; ModelId = "tev1:4b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1" } }
  "tev1-4b-cpu"           = $Ollama + @{ Gpu = $false; ModelId = "tev1:4b-q8_0"; Env = @{ OLLAMA_KEEP_ALIVE = "-1"; OLLAMA_NUM_THREAD = $CpuThreads } }
}

if ($List) { $Runs.Keys; return }
if (-not $Runs.Contains($Run)) { throw "Unknown run '$Run'. Use -List." }
$Spec = $Runs[$Run]
$BaseUrl = "http://127.0.0.1:$($Spec.Port)/v1"

function Stop-Server {
  & $Wslc stop $Spec.Name *> $null
  & $Wslc remove $Spec.Name *> $null
}

function Start-Server {
  Stop-Server
  $runArgs = @("run", "-d", "--name", $Spec.Name, "-p", "127.0.0.1:$($Spec.Port):$($Spec.ContainerPort)")
  if ($Spec.Gpu) { $runArgs += @("--gpus", "all") }
  if ($Spec.Volume) { $runArgs += @("-v", $Spec.Volume) }
  foreach ($key in $Spec.Env.Keys) { $runArgs += @("-e", "$key=$($Spec.Env[$key])") }
  $runArgs += $Spec.Image
  & $Wslc @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wslc run failed for $Run" }
}

function Wait-FirstDecision([Diagnostics.Stopwatch]$Clock) {
  $body = @{ model = $Spec.ModelId; state = "hello"; questions = @{ greeting = @{ type = "noul"; instructions = "Is this a greeting?" } } } | ConvertTo-Json -Depth 5
  while ($Clock.Elapsed.TotalSeconds -lt $ReadyTimeoutSec) {
    try {
      $null = Invoke-RestMethod -Method Post -Uri "$BaseUrl/systemone" -ContentType "application/json" -Body $body -TimeoutSec 600
      return $Clock.ElapsedMilliseconds
    } catch {
      $state = (& $Wslc inspect --format json $Spec.Name 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue)
      if ($state -and $state[0].State.Status -eq "exited") { throw "$Run exited before answering:`n$(& $Wslc logs $Spec.Name 2>&1 | Select-Object -Last 30 | Out-String)" }
      Start-Sleep -Milliseconds 1000
    }
  }
  throw "$Run gave no decision within $ReadyTimeoutSec s"
}

switch ($Action) {
  "down" { Stop-Server; return }
  "pull" {
    # Ollama runs only: download weights into the volume ahead of time, so cold start excludes them.
    if ($Spec.Image -notlike "ollama/*") { throw "$Run is not an Ollama run; its weights are fetched by its own image." }
    Start-Server
    try {
      for ($i = 0; $i -lt 60; $i++) {
        & $Wslc exec $Spec.Name ollama list *> $null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 1
      }
      & $Wslc exec $Spec.Name ollama pull $Spec.ModelId
      if ($LASTEXITCODE -ne 0) { throw "ollama pull $($Spec.ModelId) failed" }
    } finally {
      Stop-Server
    }
    return
  }
  "up" {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Start-Server
    "first decision after $(Wait-FirstDecision $clock) ms at $BaseUrl"
    return
  }
  "bench" {
    Stop-Server
    $baseline = [int](nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Start-Server
    try {
      $coldStart = Wait-FirstDecision $clock
      "[$Run] cold start: $coldStart ms (baseline VRAM $baseline MiB)"
      $nodeArgs = @("--env-file-if-exists=$Root\.env", "$Root\bench\run.ts", "--label", $Run, "--base-url", $BaseUrl,
        "--model-id", $Spec.ModelId, "--device", $(if ($Spec.Gpu) { "gpu" } else { "cpu" }), "--container", $Spec.Name,
        "--cold-start-ms", $coldStart, "--baseline-vram-mib", $baseline)
      if ($Limit -gt 0) { $nodeArgs += @("--limit", $Limit) }
      if ($Tasks) { $nodeArgs += @("--tasks", $Tasks) }
      $envNotes = ($Spec.Env.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join " "
      $nodeArgs += @("--notes", "$($Spec.Image) $envNotes")
      node @nodeArgs
      if ($LASTEXITCODE -ne 0) { throw "bench/run.ts failed for $Run" }
      Remove-Item "$Root\bench\results\$Run.failed.json" -ErrorAction SilentlyContinue
    } catch {
      # Recorded so the report lists runs that could not complete, with the reason.
      New-Item -ItemType Directory -Force "$Root\bench\results" | Out-Null
      @{ label = $Run; device = $(if ($Spec.Gpu) { "gpu" } else { "cpu" }); reason = "$_".Trim() } |
        ConvertTo-Json | Set-Content -Encoding utf8 "$Root\bench\results\$Run.failed.json"
      throw
    } finally {
      & $Wslc logs $Spec.Name *> "$Root\bench\logs\server-$Run.log"
      Stop-Server
    }
  }
}
