# ============================================================================
# Installs the Lorenco local AI worker as a Windows scheduled task that
#   - starts when the computer starts, with NOBODY logged in
#   - runs as this Windows user (so it finds this user's Ollama models)
#   - restarts itself if it stops
# Run ONCE in PowerShell "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Re-run after changing worker.js or config.env (it copies them again).
# Remove:  Unregister-ScheduledTask -TaskName "Lorenco Local AI Worker" -Confirm:$false
# ============================================================================

$ErrorActionPreference = 'Stop'
$TaskName = 'Lorenco Local AI Worker'
$Source   = $PSScriptRoot
$Target   = Join-Path $env:ProgramData 'LorencoLocalAI'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this in PowerShell "Run as administrator".'
}
if (-not (Test-Path (Join-Path $Source 'config.env'))) {
    throw 'config.env is missing — copy config.example.env to config.env and fill it in first.'
}

$node = (Get-Command node -ErrorAction Stop).Source
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
if (-not (Test-Path $ollama)) { throw "Ollama not found ($ollama)." }

# Local copy (the project folder is a synced SharePoint folder — not always on disk).
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item (Join-Path $Source 'worker.js') $Target -Force
Copy-Item (Join-Path $Source 'config.env') $Target -Force
# The scheduled task may not have this user's PATH — pin the Ollama path.
$cfgPath = Join-Path $Target 'config.env'
$cfg = Get-Content $cfgPath | Where-Object { $_ -notmatch '^\s*OLLAMA_EXE\s*=' }
$cfg += "OLLAMA_EXE=$ollama"
Set-Content -Path $cfgPath -Value $cfg -Encoding UTF8
# Only this user and administrators may read the token.
icacls $Target /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$Target\worker.js`"" -WorkingDirectory $Target
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
               -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host "Installed and started: $TaskName"
Write-Host "Files + log:            $Target  (worker.log)"
Write-Host ''
Write-Host 'Make sure the computer does not go to sleep:'
Write-Host '  Settings > System > Power > Screen and sleep > "When plugged in, put my device to sleep after" = Never'
