# Embedded Bambu Studio

The dashboard can embed the real Bambu Studio app. It runs in its own container ([linuxserver/bambustudio](https://docs.linuxserver.io/images/docker-bambustudio/)) and is streamed to the browser. You get every Studio feature (painting, supports, cutting, calibration…). Files you export from it show up on the dashboard and go through the normal print flow: plate, AMS mapping, upload over FTPS, start.

Setting this up is optional. Without it, the **Bambu Studio** card stays hidden.

## Setup

1. Start the container (the image is about 1.5 GB):
   ```bash
   docker compose -f docker-compose.studio.yml up -d
   ```
   Studio is then served on port **3100**. Its settings live in `data/studio/config`, and exports go to `data/studio/exports`.
2. Add the following to `.env`, then restart the gateway:
   ```env
   STUDIO_URL=http://<gateway host>:3100/
   STUDIO_EXPORT_DIR=./data/studio/exports
   ```
   `STUDIO_URL` is loaded by the **browser**. Use the host name or IP that the people using the dashboard can reach, not `localhost`, unless you only use the dashboard on this machine.
3. Optional but recommended on a shared network: protect the stream with basic auth. Set `STUDIO_USER` and `STUDIO_PASSWORD` in the shell or in a `.env` next to the compose file before `up`.

## Use

1. On the dashboard, open **Bambu Studio → ▶ Mở Studio**. You can also use **↗ Tab mới** for a full browser tab, or **⛶ Toàn màn hình**.
2. In Studio, prepare and slice the model, then **File → Export → Export plate sliced file** into the `/exports` folder.
   - You can also export an unsliced project `.3mf`. The gateway slices it (see [slicing.md](slicing.md)).
3. The file appears under **File Studio đã xuất** within about 10 seconds. Click **In** to continue in the print card at step 2: check the plate and the AMS mapping, then start.

You don't need to log in to Bambu Studio or connect it to the printer. The gateway does the upload and the start over LAN. If you do connect Studio to the printer as well, both open an MQTT connection to it.

## Limits

- **3D performance.** Without a GPU, the container renders OpenGL on the CPU. Large models rotate slowly. If you have an NVIDIA GPU, see the linuxserver docs for passing it to the container.
- **One session.** The container serves a single desktop. Two people who open it at the same time share the same screen.
- **Mobile.** It works, but a desktop app on a phone screen is hard to use.
- **Security.** The stream is a full desktop session inside the container. Keep it on the LAN, behind `STUDIO_PASSWORD`, and never expose port 3100 to the internet.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/studio` | `{ enabled, url, exportsEnabled, exportError, files: [{ name, size, modifiedAt }] }`. Lists `.3mf`, `.stl`, `.obj`, `.step`, `.stp` files, newest first |
| POST | `/api/studio/prepare` | Body `{ "name": "part.gcode.3mf" }`. Stages the file like `POST /api/print/prepare` and returns `{ staged }`. Only plain file names inside `STUDIO_EXPORT_DIR` are accepted |
