# Deploying MovieMaker to Neocities

MovieMaker builds to a plain static site. There is no server: the page talks to
the generation APIs directly, keeps your API keys in `localStorage`, and reads
and writes your project files straight into a folder you pick on your own disk.

## Build

```bash
npm --prefix frontend run build
```

Everything you upload is in `frontend/dist/`:

```
dist/index.html
dist/assets/index-*.js
dist/assets/index-*.css
dist/favicon.svg
dist/icons.svg
```

Asset URLs are relative, so it works at the site root (`you.neocities.org/`) or
in a subfolder (`you.neocities.org/moviemaker/`).

## Upload

Drag the **contents** of `dist/` into the Neocities file manager — not the
`dist` folder itself. To put it in a subfolder, create the folder first and
upload into it.

Neocities serves over HTTPS, which is required: the File System Access API only
works in a secure context.

## First run

1. Open the page in **Chrome or Edge**.
2. **Choose Project Folder** — pick an empty folder for a new project, or a
   previous project folder to reopen it. The browser will ask for read/write
   permission once.
3. **Settings → API Key Setup** — paste your keys. They are stored in this
   browser only and are sent straight from the page to each provider.

The folder is remembered between visits. After a browser restart you get a
one-click **Reconnect** prompt, because browsers deliberately require a fresh
gesture before handing back write access.

## What lives where

```
YourProject/
  project.mmproj.json     autosaved continuously
  assets/                 every generated image and video
```

Nothing is uploaded to Neocities. The site is static files only — it has no
server that could receive your keys or your media.

## Browser support

Requires the **File System Access API**: Chrome, Edge, and other Chromium
browsers. Firefox and Safari do not implement it and will show an explanatory
screen instead of the app.

## What the hosted build cannot do

| Feature | Status |
|---|---|
| Shot lists, assets, prompts, batch generation | Works |
| Fal.ai image and video | Works |
| Google Gemini text and image | Works |
| OpenAI text and DALL·E | Works |
| Anthropic Claude | Works (sends the direct-browser-access header) |
| Higgsfield | Should work; their CORS policy is undocumented |
| Runway, Kling direct APIs | **Blocked** — no CORS. Use their Fal/Higgsfield equivalents |
| Video stitching (Concatenate / Compile Scene) | **Unavailable** — needs FFmpeg |
| Show in Explorer | **Unavailable** — pages cannot open a file manager |

Those two unavailable buttons are visibly disabled in the hosted build rather
than failing when clicked.

### If a provider is blocked by CORS

The error message will say so. **Settings → CORS Proxy** lets you route requests
through a proxy you control:

```
https://my-proxy.example/?url={url}
```

`{url}` is replaced with the encoded target (appended if you leave it out). Use
a proxy you own — it sees your API keys in the forwarded headers.

## Running the local server build instead

The same code still runs against the Node backend, which adds FFmpeg stitching,
native OS file dialogs, and keys in `config.json` instead of `localStorage`:

```bash
npm start
```

```bash
npm run dev
```

The frontend pings the backend at startup and switches modes automatically. The
badge next to the project name shows which one is live. Append `?static=1` to
force the hosted behaviour while the backend happens to be running.

## Docker

One container: the built frontend served by the backend, with FFmpeg inside. No
Node, no FFmpeg, no npm install needed on the host.

```bash
just up      # build the image and start it, waits until it answers
just down    # stop it
just logs    # follow the log
```

Then open <http://localhost:3001>. To use another port:

```bash
MOVIEMAKER_PORT=8099 just up
```

Projects live in `./projects/` on your machine, bind-mounted into the container
alongside `config.json` (your API keys). The container itself keeps nothing, so
rebuilding it loses no work.

Two buttons cannot work in a container, the same two the hosted build disables:
**Choose Project Folder**'s native dialog and **Show in Explorer**, both of which
drive the host OS shell. Type the path instead — `/projects/YourFilm`, the
container's view of `./projects/YourFilm`. Everything else, FFmpeg stitching
included, works.

## Task runner

`just` with no arguments lists every recipe. The ones you want day to day:

| Command | What it does |
|---|---|
| `just up` / `just down` | Docker container up and down |
| `just start` / `just stop` | Local backend + Vite dev server, in the background |
| `just tail` | Follow the local server logs in `.logs/` |
| `just serve` / `just dev` | Backend or Vite alone, in the foreground |
| `just test` / `just lint` | Checks |
| `just dist` | Build `frontend/dist` for Neocities |

`just start` and `just stop` are the Unix counterpart of `start.bat` and
`stop.bat`, and work the same way: they go by port, so a stray Node process of
yours is never killed, and starting twice is harmless.
