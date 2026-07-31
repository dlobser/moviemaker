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

REM Vite 8 / rolldown need node ^20.19.0 or >=22.12.0. On anything older npm
REM silently skips rolldown's native binding (it is an optional dependency with
REM an engines field), the install "succeeds", and then `vite` dies on startup
REM complaining about a missing native binding. Catch it here instead.
set "NODE_MAJOR="
set "NODE_MINOR="
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
set "NODE_OK="
if defined NODE_MAJOR (
  if %NODE_MAJOR% GEQ 23 set "NODE_OK=1"
  if %NODE_MAJOR% EQU 22 if %NODE_MINOR% GEQ 12 set "NODE_OK=1"
  if %NODE_MAJOR% EQU 20 if %NODE_MINOR% GEQ 19 set "NODE_OK=1"
) else (
  REM Could not read the version. Let it through rather than block on a guess.
  set "NODE_OK=1"
)
if not defined NODE_OK (
  for /f %%v in ('node -v') do echo   [X] Node.js %%v is too old to build the frontend.
  echo       Vite needs 20.19+ or 22.12+. Install a current LTS from
  echo       https://nodejs.org, then delete frontend\node_modules and run
  echo       this again so the missing native binding gets installed.
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

REM The binding check is not redundant with the node_modules check: an install
REM done on too-old a Node leaves node_modules in place but without rolldown's
REM native binding, so "already installed" would otherwise stick forever.
if not exist "frontend\node_modules\" (
  echo   Installing frontend dependencies, this only happens once...
  call npm --prefix frontend install
  if errorlevel 1 goto :installfailed
) else if not exist "frontend\node_modules\@rolldown\binding-win32-*" (
  echo   Frontend dependencies are incomplete, reinstalling...
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
