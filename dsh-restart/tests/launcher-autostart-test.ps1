$ErrorActionPreference = 'Continue'
$result = 'D:\douzhongjun\dsh-restart\tests\launcher-autostart-result.json'
$startupVbs = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\dsh-autostart.vbs"
$autostartLog = "$env:LOCALAPPDATA\DshWeb\autostart.log"
$debugLog = "$env:LOCALAPPDATA\DshWeb\debug.log"

function Write-Result($obj) {
  $obj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $result -Encoding UTF8
}

try {
  # Stop both desktop shell and node service to simulate a clean boot.
  Stop-Process -Name 'DshWeb' -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match '--port 3080' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  # Run the exact autostart entry from the real Startup folder.
  & wscript.exe $startupVbs
  Start-Sleep -Seconds 2

  $portUp = $false
  $nodePid = $null
  $shellPid = $null
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline) {
    $tcp = New-Object Net.Sockets.TcpClient
    try {
      $tcp.Connect('127.0.0.1', 3080)
      $portUp = $true
      $tcp.Close()
    } catch {
      $tcp.Close()
    }
    if ($portUp) {
      $node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match '--port 3080' } |
        Select-Object -First 1
      if ($node) { $nodePid = $node.ProcessId }
      $shell = Get-CimInstance Win32_Process -Filter "Name='DshWeb.exe'" | Select-Object -First 1
      if ($shell) { $shellPid = $shell.ProcessId }
      if ($nodePid -and $shellPid) { break }
    }
    Start-Sleep -Milliseconds 750
  }

  # Give DshWeb time to finish WebView2 load and hide itself to the tray.
  Start-Sleep -Seconds 6

  $autostartTail = ''
  if (Test-Path $autostartLog) { $autostartTail = (Get-Content $autostartLog -Tail 3) -join "`n" }
  $debugTail = ''
  if (Test-Path $debugLog) { $debugTail = (Get-Content $debugLog -Tail 12) -join "`n" }

  Write-Result @{
    ok = ($portUp -and $null -ne $nodePid -and $null -ne $shellPid)
    portUp = $portUp
    nodePid = $nodePid
    shellPid = $shellPid
    autostartLog = $autostartTail
    debugLog = $debugTail
    finishedAt = (Get-Date).ToString('o')
  }
} catch {
  Write-Result @{
    ok = $false
    error = $_.Exception.Message
    finishedAt = (Get-Date).ToString('o')
  }
}
