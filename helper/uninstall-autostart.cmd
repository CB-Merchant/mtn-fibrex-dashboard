@echo off
REM ============================================================
REM  MTN FibreX Dashboard - stop the helper starting on its own
REM  Double-click this to remove the "start automatically when I
REM  sign in" shortcut created by install-autostart.cmd. The
REM  helper itself is untouched - you can still run it by hand
REM  with start-helper.cmd.
REM ============================================================
setlocal

echo Removing the MTN FibreX helper from Windows startup...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'MTN FibreX helper.lnk'; if(Test-Path $lnk){ Remove-Item $lnk -Force; Write-Host ('Removed: ' + $lnk) } else { Write-Host 'It was not set to start automatically (nothing to remove).' }"

echo.
echo Done. The helper will no longer start on its own. You can still start it
echo anytime by double-clicking start-helper.cmd.
echo.
pause
