@echo off
REM ============================================================
REM  Huawei FibreX box - can it tell us your data usage?
REM  Just double-click this file and follow the questions.
REM  It only LOOKS at your router. It changes nothing, and your
REM  password is never saved anywhere.
REM ============================================================
title Huawei router check

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

node probe-huawei.js

REM Keep the window open so the answer stays readable.
echo.
pause
