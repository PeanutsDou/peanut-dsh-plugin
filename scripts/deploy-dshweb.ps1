# Offline task: deploy the new DshWeb.exe (with --tray support) and configure autostart.
#
# ENCODING NOTE (do not remove): keep this file ASCII-only (or UTF-8 *with BOM*).
# The offline runner uses Windows PowerShell 5.1, which reads BOM-less .ps1 files
# as the system ANSI code page (GBK on Chinese Windows). Non-ASCII comments in a
# UTF-8 BOM-less file are mis-decoded and break the parser. ASCII is safe in
# every encoding, so this file uses English comments only.
$ErrorActionPreference = 'Stop'
$installDir  = "$env:LOCALAPPDATA\Programs\dsh-launcher"
$zip         = 'D:\douzhongjun\peanut-dsh-plugin\dsh-launcher\dist\dsh-launcher-windows.zip'
$autostartSrc = 'D:\douzhongjun\peanut-dsh-plugin\dsh-launcher\scripts\dsh-autostart.vbs'
$startupDir  = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"

# 1) Force-stop the desktop shell so the old exe is unlocked.
#    (The node process is handled by the restart framework.)
Stop-Process -Name 'DshWeb' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2) Extract the release package into the install dir.
if (-not (Test-Path $zip)) { Write-Error "release zip not found: $zip" }
Expand-Archive -Path $zip -DestinationPath $installDir -Force

# 3) Verify the new exe actually landed; fail loudly otherwise.
$exe = Join-Path $installDir 'DshWeb.exe'
if (-not (Test-Path $exe)) { Write-Error "deploy failed: DshWeb.exe missing in $installDir" }

# 4) Update autostart: remove the old starter, write the new one.
Remove-Item (Join-Path $startupDir 'start-dsh.vbs') -Force -ErrorAction SilentlyContinue
Copy-Item $autostartSrc (Join-Path $startupDir 'dsh-autostart.vbs') -Force

Write-Output "deploy-dshweb OK"
