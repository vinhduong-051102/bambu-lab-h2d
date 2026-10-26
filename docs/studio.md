# Embedded Bambu Studio

The dashboard embeds the real Bambu Studio app. It runs in its own container ([linuxserver/bambustudio](https://docs.linuxserver.io/images/docker-bambustudio/)) and is streamed to the browser. Models are sliced and printed **from Studio itself**; the gateway only streams it and sends files into it. The gateway does not upload or start print jobs.

Without this setup, the **Bambu Studio** card stays hidden.

## Setup

1. Build and start the container:
   ```bash
   docker compose -f docker-compose.studio.yml up -d --build
   ```
   The image is linuxserver/bambustudio with Bambu Studio rebuilt from source, to add the **AI tối ưu** button (see [AI tối ưu button](#ai-tối-ưu-button)). The first build takes one to several hours and needs about 10 GB of RAM for Docker and 20 GB of disk. Later builds reuse the compiled dependencies, and a BuildKit cache (ccache) of Studio's own sources, so changing a patch only recompiles the files it touches. `docker builder prune` clears both.
   Studio is then served on port **3100** (HTTP) and **3101** (HTTPS, self-signed certificate). Its settings live in `data/studio/config`, and files sent to it go to `data/studio/imports`.
2. Add the following to `.env`, then restart the gateway:
   ```env
   STUDIO_URL=https://<gateway host LAN IP>:3101/
   STUDIO_IMPORT_DIR=./data/studio/imports
   STUDIO_USER=admin
   STUDIO_PASSWORD=<password>
   ```
   - `STUDIO_URL` is loaded by the **browser**, so use an address every dashboard user can reach. Use HTTPS: browsers only let the stream decode video on secure pages, and `localhost` is the only plain-HTTP exception. `http://localhost:3100/` is enough if the dashboard is only used on this machine.
   - `STUDIO_USER` and `STUDIO_PASSWORD` turn on basic auth for the stream. Docker Compose reads them from the same `.env`. Run `docker compose -f docker-compose.studio.yml up -d` again after you change them.
3. The first time, open the Studio URL in its own tab (**↗ Tab mới**) and accept the self-signed certificate warning, then log in. After that the embedded frame loads too.

## Use

1. **Send the model in.** Studio runs in a container, so its file dialogs can't see your computer. On the dashboard, use **📤 Gửi file vào Studio** to send `.3mf`, `.stl`, `.obj`, `.step` or `.stp` files. They are saved to `/imports` inside Studio, and an existing name gets a ` (2)` suffix. You can also drag files onto the Studio stream; those land in `/imports` too.

   STL files sent from the dashboard are repaired on the way in, since Studio's own **Fix model** only exists on Windows. The gateway welds the mesh, removes faces that collapsed to a line or point and duplicate faces, flips faces that point against their neighbours, turns closed parts that are inside out, and closes holes it can fill safely. When it changed anything, the file as sent is kept in `/imports/.originals`, and the dashboard shows what was fixed. A repair that would leave more open or non-manifold edges than the file had is dropped, and the file is imported as sent. The gateway doesn't resolve self-intersections or non-manifold edges, and it doesn't repair STL files over 200 MB, other formats, or files dragged onto the stream.
2. **Open it in Studio:** **▶ Mở Studio**, then **File → Import** (or **Open project** for a `.3mf`), and choose the `/imports` folder.
3. **Slice and print from Studio:** **Slice plate**, then **Print plate**.

If you close Studio's window (✕), it starts again after a few seconds (`studio/labwc-autostart`). You can also right-click the empty desktop and pick **Bambu Studio**.

### AI tối ưu button

**AI tối ưu** sits left of **Slice plate** in Studio's top bar, on the Prepare and Preview tabs. It is part of Studio itself: `studio/bambustudio/ai-button.patch` adds it to Studio's source, and `studio/bambustudio/Dockerfile` builds the tagged Studio release (`BAMBUSTUDIO_TAG`) with it.

Load a model, then click **AI tối ưu**. Studio sends the plate to the gateway, which asks Claude for process and filament settings that suit the model's shape, the filament and the nozzles. Studio lists each proposed change with its reason. **Áp dụng** applies them like a manual edit: process changes to the process preset, filament changes to one filament preset, opened in the Filament tab. They show as modified there and can be reset. Save the filament preset to keep its changes for later plates. If another filament preset has unsaved edits, Studio first asks what to do with them, as when switching presets by hand; cancelling applies only the process changes. **Đóng** leaves everything as it was. To get a different proposal, write what you want in the box below the list (for example "không muốn support, gỡ khó" or "cần in nhanh") and click **Hỏi lại AI**: the AI proposes again with your comment and its earlier proposal in mind. The AI never slices or prints.

Every proposal, the changes applied from it and re-ask comments are kept as JSON files in `STUDIO_AI_DATA_DIR` (default `./data/studio/ai`), one per proposal.

The AI also learns from how earlier prints came out. Each request includes up to five earlier proposals that were applied and then reported on in **Báo cáo in**, picked from the 300 newest. Only plates with a filament type in common and the same nozzle diameters count. They are ranked by same process preset, same goal, similar height and similar share of overhanging surface, newest first on a tie. The prompt shows what was changed (value before → after), the outcome, the ticked problems and the note. The AI is told to keep changes that printed well, not to repeat ones that came with a problem, and to treat a single failure with caution.

### Print history

The gateway records every print, so a later print can be compared with earlier ones:

- **Settings:** when you send a print from Studio (**Print plate** → **Send**), Studio sends the gateway the presets, every process and filament setting, the filaments and the objects, plus the AI proposal you applied last, if any. The gateway pairs them with the job the printer starts under the same name. A print that wasn't sent from this Studio (from the printer screen or Bambu Handy, for example) is recorded without settings. The printer's storage doesn't keep LAN print files, so the settings can't be read back from the printer.
- **Photo:** when the print finishes or fails, the gateway keeps a shot from the printer camera, taken a few seconds after the end. Add your own photos (sharper, other angles) on the dashboard.
- **Gateway off at the end:** a print that ended while the gateway wasn't running is closed when the gateway starts again, without an end time or a camera photo. When the printer still shows that job, the print gets its outcome (**Hoàn thành** or **Lỗi**); once the printer shows another job, it is **Không rõ**, and your report says how it came out.
- **Report:** **Báo cáo in** in Studio (left of **AI tối ưu**) lists the recorded prints with the camera photo of the selected one. Choose how it came out, tick the problems you saw and add a note. The newest ended print without a report is preselected. The report is also saved on the AI proposal the print used.

The dashboard's **Lịch sử in** card lists the prints with their photos, settings and reports, takes extra photos and reports, and compares two prints side by side, highlighting the settings that differ.

Each print is a folder in `PRINT_HISTORY_DIR` (default `./data/prints`) with `record.json` and its photos. The gateway only records prints while it is running. A print it first sees already running is recorded without a start time.

### Timelapse

The printer keeps its timelapse videos in `/timelapse` on its storage (`video_<date>_<time>.mp4`, with a thumbnail in `/timelapse/thumbnail`). It only records one when **Timelapse** is ticked in Studio's send dialog. They are in the same list as the prints on the dashboard's **Lịch sử in** page. A video is paired with the print that names it (`timelapse` in the print's `record.json`, set by hand) or else with the print in the history that ended within 20 minutes of it: that print's row gets a **🎬 Video** badge (and the video's thumbnail when it has no photo), and the video plays in its detail window. A video whose print is older than the list has a row of its own, placed by when it ended, and plays in a window with a **⬇ Tải về** link. A video paired with no print isn't shown. The list reads the printer's videos when it opens, every 5 minutes, and on **↻ Làm mới**; when the printer can't be read, the prints still show with a note.

The gateway reads the printer's listing over FTPS (cached for 30 seconds) and copies a video or thumbnail to `TIMELAPSE_CACHE_DIR` (default `./data/timelapse`) the first time it is watched. The first play of a video takes a few seconds (about 0.7 MB per second from this printer), and later plays and seeking come from the copy. The cache isn't cleared automatically. The time in a video's file name is the printer's own clock (UTC+8 on this printer), so the dashboard shows the time the printer finished writing the file instead. Pairing by time needs the printer's clock to be right: in October 2026 it was 10 days and 6 hours behind, so the videos of 22-25/10 were matched to their prints by eye (the last frame against the camera photo) and named on them.

#### AI nhận xét (Claude reviews the timelapse)

The video window, and a print's detail window when its video is paired, have a **🤖 Nhờ AI xem video** button. The gateway cuts four frames from the video with its own ffmpeg (the H2D records one frame per layer with the toolhead parked, so they are the print at 25, 50 and 75 % of its height and finished) and has Claude look at them through `claude -p`: it describes the walls, the top and the base of the finished print, and answers with a summary, its guess at the outcome, the problems it saw (the same list as the print report), in which frame they started, and which settings to raise or lower next time (no numbers: "AI tối ưu" picks them from the real settings). The finished print goes at the camera's full resolution: it takes a small part of the view, and shrunk, its surface defects disappear.

Local models were tried first (Qwen3-VL 8B and 30B in Ollama, on the RTX 5070 Ti): shown a print with wavy walls and a rough top and a clean one, they could not tell them apart, and answered differently each run. Claude told them apart and said where the defects started.

The review is kept in `TIMELAPSE_CACHE_DIR/reviews/<video>.json` and is only shown at first. Under it, **✅ Dùng cho lần in sau** puts it to use: it is copied to the print (`video_review` in its `record.json`) and to the print's "AI tối ưu" proposal, and **Bỏ dùng** takes it off again (the review stays). "AI tối ưu" reads a used review with the past prints of similar plates, as a line marked as coming from a small model (the user's own report wins when they disagree). A proposal that was applied and printed counts as a past print once it has a report or a video review.

The printer's clock drifts (it seems to stop while the printer is off), so a video often isn't paired with its print by time. When it isn't, the video window offers the recent prints to pick from before asking for the review.

Setup: Claude Code (`claude`) installed on the gateway's machine and `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the gateway's `.env`, as for the other Claude features. `TIMELAPSE_AI_MODEL` (default `claude-opus-5-5`) picks the model. Claude may only read the frames, in a temporary folder of their own, and runs without the user's settings, hooks or sessions. A review takes about 40 seconds; reviews run one at a time.

To turn it on, either sign in with a Claude subscription (Pro/Max) or give the gateway an API key.

**With a Claude subscription, no API key.** Studio's container asks Claude itself with `claude -p` (Claude Code, installed in the image), billed to your subscription's usage limits. The gateway still builds the prompt and checks the answer. Create a long-lived token on any machine with Claude Code, put it in `.env`, then recreate the Studio container:

```bash
claude setup-token
```

```env
CLAUDE_CODE_OAUTH_TOKEN=<token printed by claude setup-token>
STUDIO_AI_MODEL=claude-opus-5-5   # optional
```

```bash
docker compose -f docker-compose.studio.yml up -d
```

The token is for your own use: keep the stream behind `STUDIO_USER`/`STUDIO_PASSWORD` and don't let other people use the button on your subscription. Updating Claude Code means rebuilding the image (only the last layer changes).

**With an API key.** Leave `CLAUDE_CODE_OAUTH_TOKEN` empty, add the key to the gateway's `.env` and restart the gateway:

```env
ANTHROPIC_API_KEY=<key>
STUDIO_AI_MODEL=claude-opus-5-5   # optional
```

Studio reaches the gateway at `http://host.docker.internal:3000`. If the gateway runs elsewhere, set `STUDIO_AI_URL` in `.env` and recreate the Studio container. When `GATEWAY_API_KEY` is set, Compose passes it to the container too.

The AI may change every numeric, on/off and choice setting of the process preset and of the filament presets used on the current plate, as Studio's editor offers them, at most one filament preset per proposal. Studio sends each preset whole with how it defines each setting (type, label in Studio's language, limits, choices, and whether only developer mode shows it), so which settings are open is decided only in the gateway (`src/domain/studio/aiOptimize.ts`), and changing that needs no Studio rebuild. The main process settings (`AI_SETTINGS`: layer heights, walls, shells, infill, top surface, wall generator and order, seam, ironing, bridges, wall and infill speeds, overhang slowdown, automatic supports and their gaps, brim, raft, elephant-foot and XY compensation) have Vietnamese labels and ranges tighter than Studio's. The others are checked against Studio's limits, except: developer-mode settings, settings that describe the material rather than how it prints (diameter, density, cost, shrinkage, soluble/support material, printable nozzles, recommended temperature range, softening temperature), and the prime tower position. Nozzle temperatures must stay in the filament's recommended range. A setting with one value per extruder variant takes one value (the first variant's; variants that differ are scaled by the same ratio) or one value per variant. The gateway rejects anything else before Studio sees it, and Studio's own parser checks every value again. The geometry the AI sees (size, volume, bed-contact and overhang areas) is estimated from the meshes of every object in the project, not from a slice. The step-by-step flow of a click is in `studio/ai-button/README.md`.

The image also applies `studio/bambustudio/popup-fixes.patch`, which fixes popups that stay on screen and stop Studio from taking clicks on Linux: the parameter tooltip, and menus that open a dialog (such as **Bind with Access Code** in the printer picker). Don't hide a stuck popup from outside the app (for example with `xdotool windowunmap`): Studio still treats it as open and ignores all input until it restarts.

To move to a new Studio release, change `BAMBUSTUDIO_TAG` in the Dockerfile, check that both patches still apply, and rebuild.

### Connecting Studio to the printer

Studio sends the job to the printer itself, so it has to be connected to it once. In the **Device** tab, add the H2D in LAN mode with its IP address and access code. Inside the container Studio can't discover the printer by broadcast, so enter the IP address by hand. Studio downloads Bambu's network plug-in on first use. The connection is saved in `data/studio/config`.

Studio and the gateway each keep their own MQTT connection to the printer.

## Opening it from another machine

A frame is only a secure page when the page around it is one too. When the dashboard itself is opened over plain HTTP from another machine (`http://<IP>:3000`), the embedded stream can't decode video, so the card opens Studio in a new HTTPS tab instead. On the Docker host (`http://localhost:3000`) it is embedded as usual.

When Studio runs on the gateway's machine, the card points it at the host the dashboard was opened with (LAN IP, Tailscale IP, `localhost`), keeping the port from `STUDIO_URL`.

To embed it from other machines too, serve both over HTTPS with Tailscale (enable **HTTPS Certificates** in the Tailscale admin console first):

```bash
tailscale serve --bg 3000                               # https://<machine>.<tailnet>.ts.net → dashboard
tailscale serve --bg --https=8443 http://localhost:3100 # https://<machine>.<tailnet>.ts.net:8443 → Studio
```

and add the Studio address to `.env`, so a dashboard opened from that name gets it:

```env
STUDIO_ALT_URLS=https://<machine>.<tailnet>.ts.net:8443/
```

## Limits

- **3D performance.** Without a GPU, the container renders OpenGL on the CPU. Large models rotate slowly. If you have an NVIDIA GPU, see the linuxserver docs for passing it to the container.
- **One session.** The container serves a single desktop. Two people who open it at the same time share the same screen.
- **Mobile.** It works, but a desktop app on a phone screen is hard to use.
- **Security.** The stream is a full desktop session inside the container. Keep it on the LAN, behind `STUDIO_PASSWORD`, and never expose ports 3100/3101 to the internet.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/studio` | `{ enabled, url, importsEnabled }` |
| POST | `/api/studio/import` | `multipart/form-data` field `file`. Saves it to `STUDIO_IMPORT_DIR` and returns `{ success, name, studioPath }`. For an STL, also `repair`: what the mesh repair did (`changed`, `holes_filled`, `faces_flipped`, `degenerate_removed`, `watertight`, …, `summary`), or `{ skipped }` with the reason |
| POST | `/api/studio/ai-optimize` | Called by Studio's **AI tối ưu** button with the plate description Studio writes. Returns `{ success, session_id, summary, changes: [{ key, label, value, reason }], rejected }`; a filament change also has `target: "filament"`, `filament` (1-based) and `preset` and keeps it as a session. With `follow_up: { session_id, comment }` in the request, the earlier proposal and the comment go into the prompt. Reported prints of similar plates go into the prompt too. 501 without `ANTHROPIC_API_KEY` |
| POST | `/api/studio/ai-optimize/prompt` | The same plate description in; `{ success, system, user, schema }` out, for `claude -p` in Studio's container. Needs no `ANTHROPIC_API_KEY` |
| POST | `/api/studio/ai-optimize/check` | `{ request, proposal }`: the plate description and the proposal from `claude -p`. Same checks and answer as `/api/studio/ai-optimize` |
| GET | `/api/studio/ai-sessions?limit=30` | Recent AI proposals, newest first, plus the `outcomes` and `issues` Studio's print report offers |
| GET | `/api/studio/ai-sessions/:id` | One proposal in full: plate, settings before, changes, re-ask comment, applied changes, print report |
| POST | `/api/studio/ai-sessions/:id/applied` | `{ changes: [{ key, value, target?, filament? }] }`: what Studio loaded into the process and filament presets |
| POST | `/api/studio/ai-sessions/:id/feedback` | `{ outcome, issues, note }`: the print report. A new report replaces the old one |
| GET | `/api/prints?limit=50` | Print history, newest first, plus the report `outcomes`, `issues` and the `setting_labels` of the settings the AI tunes |
| GET | `/api/prints/:id` | One print: `setup` (what Studio sent: presets, all process settings, filaments with their settings, setting definitions, objects, `ai_session_id`), `photos`, `feedback` |
| POST | `/api/prints/setup` | Called by Studio when it sends a print: the plate description plus `job_name` and `ai_session_id` |
| POST | `/api/prints/:id/feedback` | `{ outcome, issues, note }`: the report on the print, also saved on its AI proposal |
| POST | `/api/prints/:id/photos` | `multipart/form-data` field `file`: a JPEG, PNG or WebP photo up to 20 MB |
| GET / DELETE | `/api/prints/:id/photos/:name` | The photo, or remove it |
| GET | `/api/timelapse?refresh=1` | Timelapse videos on the printer, newest first: `{ name, size, ended_at, name_time, has_thumbnail, print }`, where `print` is the paired print or null. `refresh=1` skips the 30-second listing cache |
| GET | `/api/timelapse/:name` | The video, copied from the printer on first view. Answers `Range` requests (206) |
| GET | `/api/timelapse/:name/thumbnail` | The printer's thumbnail of the video (JPEG) |
| GET | `/api/timelapse/:name/review` | The local AI's review of the video: `{ status: none \| running \| failed \| done, review?, error?, model, outcomes, issues }` |
| POST | `/api/timelapse/:name/review` | `{ print_id? }`: has Claude review the video (202, then poll GET). The review is only shown, not used yet |
| POST | `/api/timelapse/:name/review/use` | `{ print_id? }`: uses the review for later prints: saved on the print (the one it was made for, or `print_id`) and its AI proposal |
| DELETE | `/api/timelapse/:name/review/use` | Stops using the review for later prints; the review itself stays |
