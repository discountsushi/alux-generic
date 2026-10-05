# Adaptalux pod control - setup on Windows. Run it via setup.cmd.
#   * checks for Node.js 22.13+ (installs the LTS with winget if it's missing)
#   * allows inbound TCP 4810 on private/domain networks so phones can connect
#   * adds a Startup-folder shortcut that starts the server hidden whenever you log on
#   * starts the server now and opens the app
#   setup.cmd -Restart     restart the server (after deploying an update)
#   setup.cmd -Uninstall   stop it and remove the shortcut and firewall rule (the app and data stay)
param([switch]$Uninstall, [switch]$Restart)
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $PSScriptRoot
$Vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Adaptalux pod control.lnk'
$RuleName = 'Adaptalux pod control (TCP 4810)'
$Port = 4810

# Runs a snippet with admin rights (one UAC prompt). -EncodedCommand sidesteps quoting problems.
function Invoke-Elevated([string]$Script) {
  $bytes = [Text.Encoding]::Unicode.GetBytes("`$ErrorActionPreference = 'Stop'`n" + $Script)
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', [Convert]::ToBase64String($bytes))
  if ($p.ExitCode -ne 0) { throw "the admin step failed (exit code $($p.ExitCode))" }
}

function Get-Listener { Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue }
function Stop-Server { Get-Listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }

if ($Uninstall) {
  Stop-Server
  Remove-Item $Shortcut -ErrorAction SilentlyContinue
  if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
    try { Invoke-Elevated "Remove-NetFirewallRule -DisplayName '$RuleName'" }
    catch { Write-Warning "Couldn't remove the firewall rule: $($_.Exception.Message)" }
  }
  Write-Host 'Stopped the server and removed the startup shortcut and firewall rule. The app folder and data are untouched.'
  return
}

# 1. Node.js 22.13+ (needed for the built-in SQLite)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed and winget is not available. Install Node.js LTS from https://nodejs.org, then run setup.cmd again.'
  }
  Write-Host 'Node.js not found - installing Node.js LTS with winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Get-Command node -ErrorAction Stop
}
$NodeExe = $node.Source
$version = (& $NodeExe -v).Trim().TrimStart('v')
$parts = $version.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
  throw "Node.js $version is too old - the pod control needs 22.13 or newer. Run: winget upgrade -e --id OpenJS.NodeJS.LTS"
}
Write-Host "Node.js $version ($NodeExe)"

# 1b. Dependencies: the Bluetooth module for the Adaptalux pods (@stoprocent/noble, prebuilt for
#     Windows). Optional: without it everything but real pods works, and "Sim" still connects.
Push-Location $AppDir
try {
  Write-Host 'Installing dependencies (npm install)...'
  & npm install --omit=dev --no-audit --no-fund 2>&1 | Where-Object { $_ -notmatch 'allow-scripts' } | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Write-Warning 'npm install reported a problem - real pods may not connect until it succeeds (the rest of the app is fine).' }
} finally { Pop-Location }

# 2. Firewall: let phones reach port 4810 on the home network
if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
  Write-Host "Allowing inbound TCP $Port on private networks - approve the admin prompt..."
  try {
    Invoke-Elevated "New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null"
    Write-Host 'Firewall rule added.'
  } catch {
    Write-Warning "Skipped the firewall rule ($($_.Exception.Message)). Windows may ask to allow Node.js the first time it starts instead."
  }
}
$publicNets = @(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public')
if ($publicNets.Count -gt 0) {
  Write-Warning ("Network '" + (($publicNets | ForEach-Object Name) -join "', '") + "' is set to Public, so other devices can't reach port $Port. Switch it to Private in Settings > Network & internet.")
}

# 3. Start at logon: Startup-folder shortcut -> run-hidden.vbs (no console window; output in data\server.log)
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
$link.TargetPath = $Wscript
$link.Arguments = '"{0}" "{1}"' -f $Vbs, $NodeExe
$link.WorkingDirectory = $AppDir
$link.Description = "Adaptalux pod control server on port $Port"
$link.Save()
Write-Host 'Startup shortcut added - the server starts whenever you log on.'

# 4. (Re)start now
if ($Restart) {
  Stop-Server
  Start-Sleep -Seconds 1
}
if (-not (Get-Listener)) {
  Start-Process -FilePath $Wscript -ArgumentList @("`"$Vbs`"", "`"$NodeExe`"") -WorkingDirectory $AppDir
  for ($i = 0; $i -lt 20 -and -not (Get-Listener); $i++) { Start-Sleep -Milliseconds 500 }
}
if (Get-Listener) {
  $name = $env:COMPUTERNAME.ToLower()
  Write-Host ''
  Write-Host 'Adaptalux pod control is running.'
  Write-Host "  here:          http://localhost:$Port"
  Write-Host "  phone / Mac:   http://$name.local:$Port"
  Start-Process "http://localhost:$Port"
} else {
  Write-Warning "The server didn't start - check $AppDir\data\server.log"
}
