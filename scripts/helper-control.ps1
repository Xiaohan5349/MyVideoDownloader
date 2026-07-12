param(
  [ValidateSet("start", "stop", "restart", "status", "install-autostart", "uninstall-autostart", "autostart-status")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$Port = 8765
$Root = Split-Path -Parent $PSScriptRoot
$HelperScript = Join-Path $Root "helper\server.js"
$TaskName = "DS Video Downloader Helper"

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
  $processIds = @(Get-HelperProcessIds)
  if ($processIds.Count) {
    Write-Host "Helper is already running on http://127.0.0.1:$Port/ (PID $($processIds -join ', '))."
    return
  }

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

function Install-AutoStart {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $userId = "$env:USERDOMAIN\$env:USERNAME"
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" start"
  $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the local DS Video Downloader helper after Windows sign-in." `
    -Force | Out-Null

  Write-Host "Installed auto-start task '$TaskName' for $userId."
}

function Uninstall-AutoStart {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Auto-start task is not installed."
    return
  }

  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed auto-start task '$TaskName'."
}

function Show-AutoStartStatus {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "Auto-start is not installed."
    return
  }

  Write-Host "Auto-start is installed and $($task.State.ToString().ToLowerInvariant())."
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
  "start" {
    Start-Helper
  }
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
  "install-autostart" {
    Install-AutoStart
  }
  "uninstall-autostart" {
    Uninstall-AutoStart
  }
  "autostart-status" {
    Show-AutoStartStatus
  }
}
