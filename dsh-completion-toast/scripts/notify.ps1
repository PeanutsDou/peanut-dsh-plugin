param(
  [string]$Title = 'DeepSeek Harness',
  [string]$Message = '任务完成',
  [string]$IconPath = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = $null
if ($IconPath -and (Test-Path $IconPath)) {
  try {
    $icon = New-Object System.Drawing.Icon($IconPath)
  } catch {
    $icon = $null
  }
}
if (-not $icon) {
  $icon = [System.Drawing.SystemIcons]::Information
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Visible = $true
$notify.ShowBalloonTip(5000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)

Start-Sleep -Seconds 6

$notify.Visible = $false
$notify.Dispose()
if ($icon -and $icon -ne [System.Drawing.SystemIcons]::Information) {
  $icon.Dispose()
}
