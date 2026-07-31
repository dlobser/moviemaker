# MovieMaker task runner.  `just` with no arguments lists everything.
#
# Two ways to run the app:
#   just up      docker, one container, built frontend, ffmpeg included
#   just start   local node, backend + Vite dev server, hot reload

set shell := ["bash", "-uc"]

backend_port := env("MOVIEMAKER_PORT", "3001")
frontend_port := "5173"
logs := ".logs"

_default:
    @just --list --unsorted

# --- docker -------------------------------------------------------------------

# Build the image and start the container (waits until it answers).
[group('docker')]
up:
    docker compose up -d --build --wait
    @echo "MovieMaker on http://localhost:{{backend_port}}"

# Stop and remove the container. Your projects/ folder is untouched.
[group('docker')]
down:
    docker compose down

# Restart without rebuilding.
[group('docker')]
restart:
    docker compose restart

# Follow the container log.
[group('docker')]
logs:
    docker compose logs -f

# Build the image only.
[group('docker')]
build:
    docker compose build

# A shell inside the running container.
[group('docker')]
sh:
    docker compose exec moviemaker bash

# --- local --------------------------------------------------------------------

# Install backend and frontend dependencies.
[group('local')]
install:
    npm install
    npm --prefix frontend install

# Start backend + Vite in the background, logging to .logs/.
[group('local')]
start: install
    #!/usr/bin/env bash
    set -uo pipefail
    mkdir -p {{logs}}
    just _spawn {{backend_port}} "node server.js" backend
    just _spawn {{frontend_port}} "npm --prefix frontend run dev" frontend
    for _ in $(seq 40); do
      curl -sf "http://localhost:{{frontend_port}}" >/dev/null && break
      sleep 0.5
    done
    echo "  Create  http://localhost:{{frontend_port}}"
    echo "  Edit    http://localhost:{{frontend_port}}/?view=edit"
    echo "  Logs    just tail  (stop with: just stop)"

# Stop whatever `just start` brought up.
[group('local')]
stop:
    @just _killport {{backend_port}} backend
    @just _killport {{frontend_port}} frontend

# Follow the local server logs.
[group('local')]
tail:
    tail -f {{logs}}/*.log

# Backend only, in the foreground.
[group('local')]
serve:
    node server.js

# Vite dev server only, in the foreground.
[group('local')]
dev:
    npm --prefix frontend run dev

# --- checks -------------------------------------------------------------------

[group('check')]
test:
    npm test

[group('check')]
lint:
    npm --prefix frontend run lint

# Build the static frontend into frontend/dist (also what Neocities wants).
[group('check')]
dist:
    npm --prefix frontend run build

# --- helpers ------------------------------------------------------------------

# Go by port, not process name, so an unrelated node process is never killed.
[private]
_killport port name:
    #!/usr/bin/env bash
    set -uo pipefail
    pids=$(lsof -ti "tcp:{{port}}" -sTCP:LISTEN 2>/dev/null || true)
    if [ -z "$pids" ]; then echo "  Nothing running on port {{port}}."; exit 0; fi
    kill $pids 2>/dev/null
    echo "  Stopped {{name}} (port {{port}}, pid $(echo $pids))."

# Start a command detached unless that port is already serving something.
[private]
_spawn port cmd name:
    #!/usr/bin/env bash
    set -uo pipefail
    if lsof -ti "tcp:{{port}}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  {{name}} already running on port {{port}}."; exit 0
    fi
    nohup {{cmd}} >"{{logs}}/{{name}}.log" 2>&1 &
    echo "  Started {{name}} on port {{port}} (pid $!)."
