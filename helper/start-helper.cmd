@echo off
REM ============================================================
REM  MTN FibreX Dashboard - start the local helper
REM  Just double-click this file. Leave the window open while
REM  you use the dashboard. Close it (or press Ctrl+C) to stop.
REM ============================================================
title MTN FibreX helper

REM Work from the folder this file lives in (so paths are correct)
cd /d "%~dp0"

REM Check that Node is installed and on PATH
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo.
  echo   1. Install it from https://nodejs.org  ^(pick the "LTS" button^)
  echo   2. Close this window, then RESTART your computer once
  echo      ^(so Windows notices Node^), and double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting the MTN FibreX helper...
echo (If Windows asks about firewall access, "Allow" is safe - it only
echo  listens on this computer.)
echo (This keeps the helper running: it restarts on its own if it stops, and
echo  picks up any code updates automatically - no manual restart needed.)
echo.

node supervise.js

REM If we get here the supervisor stopped (or failed to start). Keep the
REM window open so any message stays readable.
echo.
echo The helper has stopped.
pause
