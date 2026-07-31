@echo off
REM MovieMaker launcher.
REM
REM Starts the backend (FFmpeg, native dialogs, project files) and the Vite dev
REM server, then opens the app. Each server gets its own titled window so its
REM log is still there to read when something goes wrong.
REM
REM Safe to run when things are already up: anything already listening is left
REM alone rather than started twice.

setlocal
title MovieMaker launcher
cd /d "%~dp0"

echo.
echo   MovieMaker
echo   ==========
echo.

REM --- prerequisites --------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not on your PATH.
  echo       Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo   [!] FFmpeg is not on your PATH.
  echo       Everything still works except measuring clips and rendering
  echo       the edit. Install it from https://ffmpeg.org to enable those.
  echo.
)

REM --- dependencies ---------------------------------------------------------

if not exist "node_modules\" (
  echo   Installing backend dependencies, this only happens once...
  call npm install
  if errorlevel 1 goto :installfailed
)

if not exist "frontend\node_modules\" (
  echo   Installing frontend dependencies, this only happens once...
  call npm --prefix frontend install
  if errorlevel 1 goto :installfailed
)

REM --- servers --------------------------------------------------------------

call :isup 3001
if errorlevel 1 (
  echo   Starting backend on port 3001...
  start "MovieMaker backend" cmd /k "node server.js"
) else (
  echo   Backend already running on port 3001.
)

call :isup 5173
if errorlevel 1 (
  echo   Starting frontend on port 5173...
  start "MovieMaker frontend" cmd /k "npm --prefix frontend run dev"
) else (
  echo   Frontend already running on port 5173.
)

REM --- wait, then open ------------------------------------------------------

echo   Waiting for the app to come up...
powershell -NoProfile -Command "$stop=(Get-Date).AddSeconds(60); while((Get-Date) -lt $stop){ try{ $r=Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } }catch{}; Start-Sleep -Milliseconds 400 }; exit 1"

if errorlevel 1 (
  echo.
  echo   [X] The app did not come up within 60 seconds.
  echo       Check the two MovieMaker windows for the error.
  echo.
  pause
  exit /b 1
)

start "" http://localhost:5173

echo.
echo   Ready. The app is open in your browser.
echo.
echo     Create  http://localhost:5173
echo     Edit    http://localhost:5173/?view=edit
echo.
echo   Run stop.bat to shut both servers down.
echo.
REM A plain delay so the window is readable before it closes. `timeout` is not
REM used here: it refuses to run when stdin is redirected, which is exactly what
REM happens if you launch this from a shell instead of double-clicking it.
ping -n 7 127.0.0.1 >nul 2>nul
exit /b 0

REM --- helpers --------------------------------------------------------------

REM Sets errorlevel 0 when something is already listening on the given port.
:isup
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul 2>nul
exit /b %errorlevel%

:installfailed
echo.
echo   [X] Installing dependencies failed. Read the output above.
echo.
pause
exit /b 1
