@echo off
REM Shuts down whatever start.bat brought up.
REM
REM Goes by port rather than by process name so it cannot take out an unrelated
REM Node process you happen to have running.

setlocal
title MovieMaker shutdown

echo.
echo   Stopping MovieMaker...
echo.

call :killport 3001 backend
call :killport 5173 frontend

echo.
REM Not `timeout`: it fails outright when stdin is redirected.
ping -n 4 127.0.0.1 >nul 2>nul
exit /b 0

:killport
set "found="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  if not errorlevel 1 (
    echo   Stopped %~2 ^(port %~1, pid %%p^).
    set "found=1"
  )
)
if not defined found echo   Nothing was running on port %~1.
exit /b 0
