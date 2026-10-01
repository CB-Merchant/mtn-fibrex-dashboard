@echo off
REM ============================================================
REM  MTN FibreX Dashboard - start the helper automatically
REM  Double-click this once. It makes the helper start on its
REM  own every time you sign in to Windows, so your dashboard
REM  keeps collecting data without you doing anything.
REM
REM  No admin rights, nothing to install: it just drops a
REM  shortcut into your Startup folder. Undo anytime with
REM  uninstall-autostart.cmd.
REM ============================================================
setlocal
cd /d "%~dp0"

echo Setting up the MTN FibreX helper to start automatically when you sign in...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$startup=[Environment]::GetFolderPath('Startup'); $lnk=Join-Path $startup 'MTN FibreX helper.lnk'; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($lnk); $s.TargetPath='%~dp0start-helper.cmd'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Starts the MTN FibreX dashboard helper'; $s.Save(); Write-Host ('Created shortcut: ' + $lnk)"

if errorlevel 1 (
  echo.
  echo Hmm - something went wrong creating the shortcut. No harm done: you can
  echo still start the helper manually by double-clicking start-helper.cmd.
) else (
  echo.
  echo Done. From now on the helper starts automatically each time you sign in.
  echo   - It opens MINIMIZED in the taskbar ^(you don't have to watch it^).
  echo   - It starts AFTER you sign in to Windows, not at the lock screen.
  echo   - To stop it starting automatically, run uninstall-autostart.cmd.
)
echo.
pause
