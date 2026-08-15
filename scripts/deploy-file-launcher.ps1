# Offline task: deploy the file-launcher plugin files.
# ENCODING NOTE: keep this file ASCII-only (or UTF-8 with BOM); see deploy-dshweb.ps1.
$ErrorActionPreference = 'Stop'
$src = 'D:\douzhongjun\peanut-dsh-plugin\dsh-file-launcher'
$dst = 'C:\Users\DELL\.dsh\profiles\web\node_modules\@peanutsdou\dsh-file-launcher'

Copy-Item "$src\index.js","$src\launcher.html" $dst -Force
Copy-Item "$src\everything\Everything.ini" "$dst\everything\" -Force

if (-not (Test-Path "$dst\index.js")) { Write-Error "deploy failed: index.js missing in $dst" }
Write-Output "deploy-file-launcher OK"
