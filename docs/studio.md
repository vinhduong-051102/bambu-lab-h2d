# Embedded Bambu Studio

The dashboard embeds the real Bambu Studio app. It runs in its own container ([linuxserver/bambustudio](https://docs.linuxserver.io/images/docker-bambustudio/)) and is streamed to the browser. Models are sliced and printed **from Studio itself**; the gateway only streams it and sends files into it. The gateway does not upload or start print jobs.

Without this setup, the **Bambu Studio** card stays hidden.

## Setup

1. Start the container (the image is about 1.5 GB):
   ```bash
   docker compose -f docker-compose.studio.yml up -d
   ```
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
