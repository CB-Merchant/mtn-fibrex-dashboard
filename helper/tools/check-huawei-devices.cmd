@echo off
REM ============================================================
REM  Huawei FibreX box - who is connected to it?
REM  Checks whether the box will tell us the list of connected
REM  devices (names, IPs, online/offline) so the dashboard's
REM  "Connected devices" panel can show real data.
REM  It only LOOKS. Nothing on your router is changed, and your
REM  password is never saved.
REM ============================================================
title Huawei connected devices

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

node probe-huawei-devices.js

REM Keep the window open so the answer stays readable.
echo.
pause
