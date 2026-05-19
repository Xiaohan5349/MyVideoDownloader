param(
  [ValidateSet("stop", "restart", "status")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$Port = 8765
$Root = Split-Path -Parent $PSScriptRoot
$HelperScript = Join-Path $Root "helper\server.js"

function Get-HelperProcessIds {
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  $connections | Select-Object -ExpandProperty OwningProcess -Unique
}

function Stop-Helper {
  $processIds = @(Get-HelperProcessIds)
  if (-not $processIds.Count) {
    Write-Host "Helper is not running on port $Port."
    return
  }

  foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force
    Write-Host "Stopped helper process $processId."
  }
}

function Start-Helper {
  $node = Get-Command node -ErrorAction Stop
  $process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @($HelperScript) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Milliseconds 700
  Write-Host "Started helper process $($process.Id) on http://127.0.0.1:$Port/."
}

function Show-Status {
  $processIds = @(Get-HelperProcessIds)
  if (-not $processIds.Count) {
    Write-Host "Helper is stopped."
    return
  }

  foreach ($processId in $processIds) {
    Write-Host "Helper is running on http://127.0.0.1:$Port/ (PID $processId)."
  }
}

switch ($Action) {
  "stop" {
    Stop-Helper
  }
  "restart" {
    Stop-Helper
    Start-Helper
  }
  "status" {
    Show-Status
  }
}
