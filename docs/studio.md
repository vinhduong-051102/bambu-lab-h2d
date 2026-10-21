# Embedded Bambu Studio

The dashboard embeds the real Bambu Studio app. It runs in its own container ([linuxserver/bambustudio](https://docs.linuxserver.io/images/docker-bambustudio/)) and is streamed to the browser. Models are sliced and printed **from Studio itself**; the gateway only streams it and sends files into it. The gateway does not upload or start print jobs.

Without this setup, the **Bambu Studio** card stays hidden.

## Setup

1. Build and start the container:
   ```bash
   docker compose -f docker-compose.studio.yml up -d --build
   ```
   The image is linuxserver/bambustudio with Bambu Studio rebuilt from source, to add the **AI tối ưu** button (see [AI tối ưu button](#ai-tối-ưu-button)). The first build takes one to several hours and needs about 10 GB of RAM for Docker and 20 GB of disk. Later builds reuse the compiled dependencies.
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
2. **Open it in Studio:** **▶ Mở Studio**, then **File → Import** (or **Open project** for a `.3mf`), and choose the `/imports` folder.
3. **Slice and print from Studio:** **Slice plate**, then **Print plate**.

If you close Studio's window (✕), it starts again after a few seconds (`studio/labwc-autostart`). You can also right-click the empty desktop and pick **Bambu Studio**.

### AI tối ưu button

**AI tối ưu** sits left of **Slice plate** in Studio's top bar, on the Prepare and Preview tabs. It is part of Studio itself: `studio/bambustudio/ai-button.patch` adds it to Studio's source, and `studio/bambustudio/Dockerfile` builds the tagged Studio release (`BAMBUSTUDIO_TAG`) with it.

Load a model, then click **AI tối ưu**. Studio sends the plate to the gateway, which asks Claude for process settings that suit the model's shape, the filament and the nozzles. Studio lists each proposed change with its reason. **Yes** applies them to the process preset like a manual edit: they show as modified in the Process tab and can be reset there. **No** leaves everything as it was. The AI never slices or prints.

To turn it on, add the Claude API key to the gateway's `.env` and restart the gateway:

```env
ANTHROPIC_API_KEY=<key>
STUDIO_AI_MODEL=claude-opus-5-5   # optional
```

Studio reaches the gateway at `http://host.docker.internal:3000`. If the gateway runs elsewhere, set `STUDIO_AI_URL` in `.env` and recreate the Studio container. When `GATEWAY_API_KEY` is set, Compose passes it to the container too.

The AI may change layer heights, walls, top/bottom shells, infill density and pattern, top surface pattern, wall generator and order, seam, ironing, supports (automatic types only) and brim. The gateway rejects any other key, and any value outside its allowed range, before Studio sees it. The geometry the AI sees (size, volume, bed-contact and overhang areas) is estimated from the meshes of every object in the project, not from a slice. The step-by-step flow of a click is in `studio/ai-button/README.md`.

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
| POST | `/api/studio/import` | `multipart/form-data` field `file`. Saves it to `STUDIO_IMPORT_DIR` and returns `{ success, name, studioPath }` |
| POST | `/api/studio/ai-optimize` | Called by Studio's **AI tối ưu** button with the plate description Studio writes. Returns `{ success, summary, changes: [{ key, label, value, reason }], rejected }`. 501 without `ANTHROPIC_API_KEY` |
