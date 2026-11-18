# ffmpeg helper

A local web UI for the ffmpeg jobs you keep looking up. Pick files, tweak a few settings, and watch the
progress bar. Every form also shows the exact `ffmpeg` command it will run, so you can copy it.

It needs only Node 18+ and ffmpeg/ffprobe; there are no npm packages to install.

## Run it

```bash
npm start
```

Or double-click **`start.bat`**. This opens http://127.0.0.1:8642 in your browser. Close the window or
press Ctrl+C to stop it.

- ffmpeg and ffprobe must be on your `PATH`. Otherwise set `FFMPEG_PATH` and `FFPROBE_PATH`.
- `PORT=9000 npm start` changes the port. If the port is busy, the next free one is used.
- `npm run dev` starts the server without opening a browser.
- `FFH_CONCURRENCY=1` runs jobs one at a time. The default is 2 at once; extra jobs wait in a queue.

## Tools

| Tool | What it does |
| --- | --- |
| **Images → Video** | Pick any frame of a numbered sequence (`render_0001.png`…) and it finds the rest. You can set start/end frame, fps, codec (H.264/H.265/VP9/AV1/ProRes), CRF and preset, and resize. Alpha is kept with VP9 or ProRes 4444. Gaps in the sequence are flagged. EXR is converted from linear to sRGB. |
| **Convert / Compress** | Re-encodes a video with a new codec, size or fps, and can change speed (audio pitch is kept) or drop the audio. **Target file size** does a 2-pass H.264 encode to hit a size in MB. |
| **Add Audio to Video** | Replaces or mixes the soundtrack, with an offset (negative skips into the audio), volume in dB, and looping to fill the video. You choose whether the output matches the video, the shorter file, or the longer one. The video is stream-copied unless you choose to re-encode. |
| **GIF / Animated WebP** | Works from a video clip or an image sequence. GIFs use a generated palette with a dithering choice and a "moving parts only" palette mode. WebP can keep transparency. Both have ping-pong (forward then backward) and play-once options. |
| **Sprite Sheet** | Arranges frames from a video or sequence into a columns × rows grid. Frames are either spread evenly over the range or taken consecutively. You set the final sheet resolution (leave one side blank to keep the aspect ratio), the spacing, and fit/fill/stretch. The background stays transparent; you can also key out a green screen. It can also write a `.json` file with frame rectangles. |
| **Video → Frames** | Exports every frame, or N per second, as PNG/JPG/WebP. |
| **Convert Images** | Batch-converts every image in a folder (optionally with subfolders, mirrored in the output folder), or files you pick, to JPG, PNG, WebP, TIFF or BMP. Settings: JPG quality and chroma subsampling, WebP quality or lossless, PNG/TIFF compression. Transparent areas are filled with a background color for formats that can't store transparency. Resizing can **fit** inside a size keeping the aspect ratio (optionally without enlarging, or padded to the exact size), **stretch** to an exact size, or **fill and crop** to it from the center or an edge. Several images convert at once, and one bad file doesn't stop the rest. |
| **Convert Audio** | Converts one file or a batch to MP3, WAV, FLAC, AAC, Opus, Ogg Vorbis, AIFF, Apple Lossless, WMA or AC3, or any other extension ffmpeg knows. You set the bitrate (CBR or VBR for MP3), bit depth, sample rate and channels. Tags and cover art are kept. If a format can't take the source's sample rate or channel count, the audio is resampled or mixed down and the preview says so. Files are saved next to the originals or in a folder you choose. |
| **Audio Effects** | Stacks effects in any order: high/low/band-pass, EQ, bass & treble, compressor, limiter, gate, normalize, distortion, bitcrusher, low sample rate, noise/crackle, signal dropouts, radio squelch, reverb, echo, chorus, flanger, phaser, tremolo, vibrato, wow & flutter, ring modulator, pitch, speed, reverse, mono and stereo width. Drag cards to reorder, bypass any of them, and pick per-effect presets. Whole-chain presets include airport-tower radio (ATC), telephone, walkie-talkie, vintage radio and vinyl, rooms, robot and more; you can save your own. **Preview** renders a few seconds so you can A/B against the original, and re-renders as you tweak. Works on video too (the video is copied). |
| **Extract Audio** | Copies the original stream without re-encoding, or converts to MP3/WAV/FLAC/AAC/Opus. Optional mono downmix and time range. |
| **Fade & Trim Audio** | Cuts out a section with fade in/out (several curve shapes), a volume change, and optional loudness normalization. |
| **Loop Audio** | *Seamless loop*: crossfades the end of the clip into its start, so the file loops without a click. *Repeat N times* or *repeat to a length*: crossfades every join, with an optional fade-out at the end. |
| **Split on Silence** | Click **Find sounds** to draw the waveform and mark each sound. Click a sound to hear it, untick the ones you don't want, adjust the padding, then export each sound as its own file. |
| **Trim / Cut** | Fast mode copies the stream, which is instant but cuts on keyframes. Accurate mode re-encodes and can fade in/out. Works for video and audio. |
| **Concat / Join** | Joins videos or MP3s end to end. Fast mode needs files in the same format. Re-encode mode handles mixed sizes and codecs (letterboxed) and can crossfade audio-only files. |
| **Media Info** | Shows ffprobe details for any file. |

## Web version (ffmpeg.wasm)

The same app also runs as a static web page, with ffmpeg compiled to WebAssembly running in the visitor's
browser. Files are never uploaded; results are downloaded (several at once come as a zip). Its **Run it on your
computer** page explains why the desktop version is worth it, and **Download ffmpeg-helper.zip** gives
visitors this app, built in the browser from copies the site serves.

```bash
npm install            # once: fetches @ffmpeg/core (the WebAssembly ffmpeg), used only by this build
npm run build:web      # writes ../MovieMaker/frontend/public/ffmpeghelp (or: node scripts/build-web.js <folder>)
npm run serve:web      # serves it at http://127.0.0.1:8650/ffmpeghelp/ to test
```

It's published at **https://dlobser.github.io/moviemaker/ffmpeghelp/**: MovieMaker's GitHub Pages workflow
builds its Vite frontend, which copies `public/ffmpeghelp` into the site as-is. Commit the folder and push.
The build replaces its output folder each time and refuses to touch a folder it didn't make.

The output is plain static files and loads nothing from other sites. ffmpeg's `.wasm` is split into parts, and
the desktop version is kept as `.txt` copies under `local/` that the page zips up. A free Neocities site still
can't host it: Neocities checks file contents, and two of the parts look like a `.wasm` file and a Targa image.

What's different in the browser:

- It's much slower. One thread of WebAssembly re-encoded a 5-second HD clip in 18 s, against 0.6 s for native
  ffmpeg on the same machine. One command runs at a time, and the first visit loads 32 MB.
- ffmpeg gets at most 2 GB of memory, so very long or large videos can fail.
- The build includes ffmpeg 5.1. It can make H.264 and ProRes video, but not H.265, VP9 or AV1: the encoders are
  missing, or they fail or hang. Those choices are hidden.
- Files are picked with the browser's file chooser (or dropped onto a field). For an image sequence, select all
  its frames. Output folders are replaced by downloads.

`web/ffh-web.js` runs `lib/media.js`, `lib/ops.js` and `lib/jobs.js` unchanged. It gives them stand-ins for
`fs`, `path`, `child_process` and the other Node APIs they use, with each "child process" being an ffmpeg.wasm
command in a Web Worker (`web/ffh-worker.js`), and it answers the UI's `/api/...` calls in the page. If a
command fails, the worker is restarted with its files carried over, because a failure can corrupt
ffmpeg.wasm's memory. Cancelling a job also restarts the worker.

## How it works

- `server.js` is a plain Node HTTP server, bound to `127.0.0.1` only. Its API refuses cross-site requests.
- `lib/ops.js` turns each form into one or more ffmpeg commands. `lib/jobs.js` runs them as a queue.
- Progress comes from `ffmpeg -progress`: output time or frame count compared with the expected total.
  Some filters hold every frame before writing anything (GIF palettes, sprite sheet tiling). For those,
  a `showinfo` filter reports how far the input has been read. Progress also appears in the browser
  tab title and favicon.
- **Browse…** opens your OS's native file dialog through the server, because browsers don't give web
  pages real file paths. You can also paste a path into any field; quotes from Explorer's "Copy as path"
  are fine.
- Cancelling a job kills ffmpeg and deletes that job's half-written output.
