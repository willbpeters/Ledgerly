@echo off
rem Starts Tally in test mode (npm run tauri dev), so it always runs your
rem latest code. The Desktop shortcut "Tally (test)" points here.
rem Closing this window closes Tally.
title Tally (test)

rem Rust is installed but its folder is not on the user PATH on this machine,
rem so add it here rather than relying on every terminal being set up.
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

rem Run from the project folder, wherever this script was started from.
cd /d "%~dp0.."

call npm run tauri dev

rem Keep the window open on a failure so the error can be read.
if errorlevel 1 (
  echo.
  echo Tally stopped with an error. Read the message above, then press any key.
  pause >nul
)
