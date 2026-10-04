<#
.SYNOPSIS
  Waits for a RunPod benchmark run to finish and downloads its result and logs.

.DESCRIPTION
  The run itself happens on the pod (bench/pod/run.sh, started by the bench-ollama template;
  see bench/pod/README.md): Ollama and bench/run.ts share the pod, so latencies have no network
  round trip. It writes results/<Label>.json (or <Label>.failed.json) and logs/<Label>.log to
  the pod's network volume; this script polls for them through RunPod's S3-compatible API and
  copies them into bench/results/ and bench/logs/.

  Needs uv (for `uvx --from awscli aws`) and RUNPOD_S3_ACCESS_KEY / RUNPOD_S3_SECRET_KEY in .env.
  Objects are probed by name, never listed: listing a volume that holds GBs of weights is slow.

.EXAMPLE
  ./bench/remote.ps1 -Label clef-ollama-gpu-24gb -VolumeId abc123xyz -DataCenter EUR-IS-1
#>
param(
  [Parameter(Mandatory)][string]$Label,
  [Parameter(Mandatory)][string]$VolumeId,
  [Parameter(Mandatory)][string]$DataCenter,
  [int]$TimeoutMin = 180
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (Test-Path "$Root\.env") {
  foreach ($line in Get-Content "$Root\.env") {
    if ($line -match '^\s*(RUNPOD_S3_[A-Z_]+)\s*=\s*(.*?)\s*$') { Set-Item "env:$($Matches[1])" $Matches[2] }
  }
}
if (-not $env:RUNPOD_S3_ACCESS_KEY -or -not $env:RUNPOD_S3_SECRET_KEY) { throw "RUNPOD_S3_ACCESS_KEY / RUNPOD_S3_SECRET_KEY are not set (.env)" }
$env:AWS_ACCESS_KEY_ID = $env:RUNPOD_S3_ACCESS_KEY
$env:AWS_SECRET_ACCESS_KEY = $env:RUNPOD_S3_SECRET_KEY
$S3 = @("--from", "awscli", "aws", "--region", $DataCenter, "--endpoint-url", "https://s3api-$($DataCenter.ToLower()).runpod.io")

function Test-Object([string]$Key) {
  & uvx @S3 s3api head-object --bucket $VolumeId --key $Key *> $null
  $LASTEXITCODE -eq 0
}

function Get-Object([string]$Key, [string]$Destination) {
  New-Item -ItemType Directory -Force (Split-Path -Parent $Destination) | Out-Null
  & uvx @S3 s3 cp "s3://$VolumeId/$Key" $Destination --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "download of $Key failed" }
}

$clock = [Diagnostics.Stopwatch]::StartNew()
"[$Label] waiting for results/$Label.json on volume $VolumeId ($DataCenter)"
while ($clock.Elapsed.TotalMinutes -lt $TimeoutMin) {
  foreach ($name in "$Label.json", "$Label.failed.json") {
    if (Test-Object "results/$name") {
      Get-Object "logs/$Label.log" "$Root\bench\logs\runpod-$Label.log"
      Get-Object "logs/$Label.ollama.log" "$Root\bench\logs\runpod-$Label.ollama.log"
      Get-Object "results/$name" "$Root\bench\results\$name"
      if ($name -eq "$Label.json") {
        Remove-Item "$Root\bench\results\$Label.failed.json" -ErrorAction SilentlyContinue
        "[$Label] downloaded bench/results/$name after $([int]$clock.Elapsed.TotalMinutes) min"
        return
      }
      throw "[$Label] the run failed: $((Get-Content -Raw "$Root\bench\results\$name" | ConvertFrom-Json).reason). Log: bench/logs/runpod-$Label.log"
    }
  }
  Start-Sleep -Seconds 60
}
throw "[$Label] no result after $TimeoutMin min"
