@echo off
setlocal

rem Remove the autostart entry and desktop shortcuts created by dsh-launcher.

rem 1) Startup-folder entries (the actual autostart mechanism). Both historical
rem    file names are covered: the old start-dsh.vbs and the newer
rem    dsh-autostart.vbs that also starts the tray shell.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "REMOVED=0"
for %%F in ("%STARTUP%\start-dsh.vbs" "%STARTUP%\dsh-autostart.vbs") do (
  if exist "%%~F" (
    del /q "%%~F"
    echo [OK] Removed autostart entry: "%%~F"
    set "REMOVED=1"
  )
)
if not "%REMOVED%"=="1" echo [SKIP] No dsh-launcher autostart entry in the Startup folder.

rem 2) Desktop shortcuts (any name starting with DshWeb / DeepSeek Harness,
rem    also checks the OneDrive-redirected Desktop)
for %%D in ("%USERPROFILE%\Desktop" "%USERPROFILE%\OneDrive\Desktop") do (
  if exist "%%~D\DshWeb*.lnk" (
    del /q "%%~D\DshWeb*.lnk"
    echo [OK] Removed desktop shortcuts: "%%~D\DshWeb*.lnk"
  )
  if exist "%%~D\DeepSeek Harness*.lnk" (
    del /q "%%~D\DeepSeek Harness*.lnk"
    echo [OK] Removed desktop shortcuts: "%%~D\DeepSeek Harness*.lnk"
  )
)

echo.
echo dsh-launcher autostart entry and desktop shortcuts removed.
pause
