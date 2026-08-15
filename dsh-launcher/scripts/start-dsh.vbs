' DeepSeek Harness silent launcher (no window). Used by autostart / one-click entry.
' Starts `dsh web` and writes log to %USERPROFILE%\.dsh-web.log
'
' Robustness notes:
'  - Prefer the absolute node.exe + dsh bin.js path so a missing PATH entry at
'    logon time cannot silently break the service start.
'  - Fall back to the `dsh` shim if the absolute files are not found (for
'    non-standard installs).
'  - ENCODING NOTE: keep this file ASCII-only (or UTF-16 with BOM). WScript
'    reads BOM-less .vbs as the system ANSI code page.
Option Explicit

Dim sh, fso, nodeExe, dshBin, logFile, cmd, installDir, Q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Q = Chr(34)

installDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\dsh-launcher"
If fso.FolderExists(installDir) Then
    On Error Resume Next
    sh.CurrentDirectory = installDir
    On Error GoTo 0
End If

nodeExe = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
dshBin = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
logFile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh-web.log"

If fso.FileExists(nodeExe) And fso.FileExists(dshBin) Then
    ' cmd /c ""C:\...\node.exe" "C:\...\bin.js" web ... > "C:\...\log" 2>&1"
    ' The extra outer quote pair is required by cmd's quote-stripping rules.
    cmd = "cmd /c " & Q & Q & nodeExe & Q & " " & Q & dshBin & Q & _
          " web --host 127.0.0.1 --port 3080 > " & Q & logFile & Q & " 2>&1" & Q
Else
    cmd = "cmd /c ""dsh web --host 127.0.0.1 --port 3080 > %USERPROFILE%\.dsh-web.log 2>&1"""
End If

sh.Run cmd, 0, False
