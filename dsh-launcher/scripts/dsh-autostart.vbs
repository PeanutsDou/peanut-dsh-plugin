' DeepSeek Harness autostart.
'
' Strategy: start the desktop shell in tray mode and let DshWeb.exe itself
' start the DSH node service (it polls port 3080 and runs start-dsh.vbs when
' needed). Starting the service here as well races a second `dsh web` process
' on slow boots, which is why the old version sometimes failed to come up.
'
' If the shell exe is missing, fall back to starting the service directly so a
' headless DSH is still available.
'
' ENCODING NOTE: keep this file ASCII-only (or UTF-16 with BOM). WScript reads
' BOM-less .vbs as the system ANSI code page.
Option Explicit

Dim sh, fso, dshWeb, serviceVbs, installDir, logFile
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

installDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\dsh-launcher"
dshWeb = installDir & "\DshWeb.exe"
serviceVbs = installDir & "\start-dsh.vbs"

' Fixed working directory: otherwise the service inherits the Startup-folder /
' caller cwd and relative paths can leak outside the install dir.
If fso.FolderExists(installDir) Then
    On Error Resume Next
    sh.CurrentDirectory = installDir
    On Error GoTo 0
End If

If fso.FileExists(dshWeb) Then
    ' Tray mode: DshWeb waits for port 3080 (up to 90s), starts the service via
    ' its local start-dsh.vbs when needed, then hides itself to the tray.
    ' The double-Ctrl hotkey is available as soon as DshWeb has started.
    sh.Run """" & dshWeb & """ --tray", 0, False
ElseIf fso.FileExists(serviceVbs) Then
    ' Shell not installed: at least bring the node service up headlessly.
    sh.Run "wscript.exe """ & serviceVbs & """", 0, False
Else
    ' Last-resort shim start (same as the original behavior).
    sh.Run "cmd /c ""dsh web --host 127.0.0.1 --port 3080 > %USERPROFILE%\.dsh-web.log 2>&1""", 0, False
End If

' Small diagnostic log so a failed boot is not silent.
On Error Resume Next
logFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DshWeb\autostart.log"
fso.CreateFolder(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DshWeb")
Dim out, stamp
Set out = fso.OpenTextFile(logFile, 8, True)
stamp = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & _
        " " & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2)
out.WriteLine stamp & " autostart: dshWeb=" & dshWeb & " exists=" & fso.FileExists(dshWeb)
out.Close
