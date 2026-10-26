# AI model design

The dashboard's **Thiết kế mô hình bằng AI** card turns a description ("giá đỡ điện thoại nghiêng 60°, rộng 80 mm, dày 3 mm") into a model ready to print. Claude writes the model as [build123d](https://build123d.readthedocs.io) Python code, builds it, looks at a preview, fixes what is off, and hands back STL, STEP, the code and a short summary. Antigravity can design models with the same tools through an MCP server.

Characters, animals, statues and other organic shapes, which build123d can't make, come from a second container, `mesh3d` ([Figures](#figures-nhân-vật--trang-trí)): Tencent's Hunyuan3D-2 turns a picture into a 3D shape on the NVIDIA GPU.

Everything runs in its own containers, `cad` (`docker-compose.cad.yml`) and `mesh3d` (`docker-compose.mesh3d.yml`): the model code is untrusted, and Claude runs commands while it works. The gateway only stores jobs and passes them on.

Without either container set up, the card stays hidden. With one of them, the card offers only that kind of model.

## How it works

1. The dashboard posts the description to `POST /api/cad/jobs`. The gateway makes a job folder in `CAD_JOBS_DIR` (`job.json`, and Claude's brief in `request.md`) and asks the worker to start.
2. The worker (`cad/worker.py`) runs `claude -p` in that folder, with only the Bash, Read, Write and Edit tools and the instructions in `cad/prompt.md`. Claude reads the modelling rules in `cad/guide.md`, writes `model.py`, builds it with `python /opt/cad/build.py model.py`, reads `out/preview.png` (four views) and the build report, and repeats until the model matches, at most 6 builds.
3. `cad/build.py` runs the code, exports `result` to `out/model.stl` and `out/model.step`, renders the preview, and reports the size, volume, whether the mesh is watertight and anything to check: larger than the H2D's 320 × 320 × 320 mm, not sitting on Z = 0, an invalid shape.
4. The worker writes Claude's progress lines and the result to `status.json`; the dashboard polls it. When Claude is done, the worker builds `model.py` once more so the files always match the code that was kept.

Claude runs on your Claude subscription through `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), the same token as Studio's **AI tối ưu**, so models count against the plan's usage limits rather than API billing. A model takes a few minutes and usually 2 to 4 builds. Sonnet uses less of the limits than Opus; Opus is better at parts that have to fit something. A run is stopped after 20 minutes (`CAD_AI_TIMEOUT_S`) or 60 turns.

## Setup

1. Build and start the container:
   ```bash
   docker compose -f docker-compose.cad.yml up -d --build
   ```
   The image has Python 3.12, build123d (with OpenCascade), matplotlib and Claude Code, about 1.5 GB. The worker's scripts are mounted from `./cad`, so changes to them only need `docker compose -f docker-compose.cad.yml restart`. The worker listens on `127.0.0.1:3102` only.
2. Add to `.env`, then restart the gateway:
   ```env
   CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
   CAD_WORKER_URL=http://127.0.0.1:3102
   CAD_JOBS_DIR=./data/cad/jobs
   CAD_AI_MODEL=claude-opus-5-5
   ```
   The gateway reads the job files directly, so it must run on the Docker host, with `CAD_JOBS_DIR` the folder the compose file mounts at `/jobs`. `CAD_AI_MODEL` is the model the dashboard selects first (`claude-opus-5-5` or `claude-sonnet-5-5`).
3. For **📤 Gửi sang Studio**, set up Studio's import folder (`STUDIO_IMPORT_DIR`, see [studio.md](studio.md)).

## Use

- Describe the part, with the dimensions that matter, pick the model and click **✨ Tạo mô hình**. The card shows what Claude is doing and its notes while it works; **⏹ Hủy** stops it.
- A finished model shows its preview (click it for full size), size, volume, warnings, and under **Chi tiết từ Claude** its summary, the assumptions it made and the dimensions you can change in the code.
- **📤 Gửi sang Studio** puts the STL into Studio's `/imports` folder, repaired like any STL sent from the dashboard. **⬇ STL**, **⬇ STEP** and **📄 Code** download the files; the STEP opens in Fusion 360 or FreeCAD for manual changes.
- **✏️ Sửa** asks Claude to change the model ("dày thêm 1 mm", "bo tròn các góc"). The revision is a new job that starts from the previous code and brief, so the original stays.

## Figures (Nhân vật / trang trí)

Pick **🧸 Nhân vật / trang trí** on the card. The `mesh3d` worker (`mesh3d/worker.py`) makes the model in about a minute:

1. **The picture.** An uploaded picture (PNG, JPEG or WebP, up to 15 MB) gives the closest result: one subject, whole, front three-quarter view, plain background. Without one, Claude (Haiku, through `claude -p` on the same `CLAUDE_CODE_OAUTH_TOKEN`) turns the description into an English picture brief, and HunyuanDiT draws it in a clay-figure style on a white background. The background is then removed; the picture is kept as **🖼 Ảnh gốc**.
2. **The shape.** Hunyuan3D-2mini (the turbo version, a few seconds on the GPU) turns the picture into a mesh.
3. **Ready to print.** The worker turns it Z up with the front facing −Y, drops floating specks, reduces it to 200,000 faces, repairs non-manifold edges and closes holes, scales it to the height asked for (10–300 mm, the plinth not counted), centres it on the plate at Z = 0, and with **Thêm đế** adds a round plinth under it. It warns when the figure stands on very little without a plinth, or is so small that fine details won't print.

### Colour

With **Tô màu**, the figure is printed in several filaments (the AMS changes them while printing):

1. Hunyuan3D-Paint textures a 40,000-face copy of the shape from the picture (shading removed first, so the texture holds the subject's own colours).
2. Every face of the printable mesh takes the texture's colour under it. The colours are then cut down to the filaments: **Tự chọn màu theo ảnh** finds the given number (2–8) by k-means in Lab colour space, weighted by area, the most used becoming filament 1; **Màu đang nạp trong AMS** gives each face the nearest of the colours loaded in the AMS, in the order Studio lists them after syncing the AMS (unit by unit, slot by slot, empty slots left out). Specks and one-face fringes take the colour around them. The plinth takes the figure's main colour.
   - **Màu Bambu chính hãng** does the same as the first, then moves each colour to the nearest of Bambu's own colours of one material (e.g. PLA Basic) or a whole family (**Mọi dòng PLA**: Basic, Matte, Silk, Lite … print together and offer far more colours); colours landing on the same filament merge. The palette names each filament with its spool code, e.g. "PLA Basic Orange (10300)". The colours come from Bambu Studio's `filaments_color_codes.json`, downloaded once into `data/bambu/`.
   - **Filament của tôi** does the same with filaments you saved: other brands, or colours Bambu doesn't make. Add them under **🎨 Filament của tôi** (name, brand, material, colour), then tick the ones to paint with. They are kept in `data/filaments/custom.json`.

   For every filament the palette shows the model's own colour there and how far the filament is from it (Lab ΔE: giống, gần đúng, hơi lệch, lệch rõ); the card warns about one that is plainly off. When a filament is off by more than ΔE 6, the palette suggests the Bambu Studio mixing recipe that prints closest to the model's colour: two or three PLA Basic primaries (Cyan, Magenta, Yellow, White or Red, Yellow, Blue, White) in 20–80 % shares, from Studio's measured `standard_color_recipes.json`. Mixing itself is set up in Studio.
3. `out/model.3mf` holds the mesh with every triangle painted (Bambu's `paint_color`: paint state *n* is filament *n* in Studio). **📤 Gửi sang Studio (có màu)** sends it; in Studio, set filaments 1–n to the colours the card lists, or sync the AMS when the colours came from it. The preview shows the figure in its filaments.

Colour adds 1–2 minutes and, the first time, an 18 GB download (Hunyuan3D-Paint turbo and its de-lighting model). The texture stage needs a CUDA rasterizer compiled into the image (`TORCH_CUDA_ARCH_LIST`, by default RTX 30xx, 40xx and 50xx). Fine details under about 0.5 mm (pupils, whiskers) may be lost or smudged, and every colour change costs purge filament and time; the card warns when the AMS colours mix materials (PLA with PETG bonds poorly).

The result has an STL (and with colour a 3MF) and a preview, no STEP or code. **🎲 Tạo lại** makes it again from the same picture or description, size and plinth with another seed: a different take on the same subject. The height is right; the rest of the shape is the model's own guess, so check the preview before printing.

The models take GPU memory only while there is work: they load with the first figure (about 2 minutes, shown as its own step) and leave the GPU after 10 minutes without one (`MESH_IDLE_UNLOAD_S`). Shape generation needs about 5 GB of VRAM; drawing a picture moves HunyuanDiT's parts onto the GPU one at a time. Figures are made one at a time; others wait in the queue.

### Claude review & sửa

Hunyuan3D-2 guesses what the picture doesn't show, and a busy picture leaves its marks: feet cut off at the ankle,
a figure standing on two points, loose specks, clothes crumpled by a glow or aura in the picture, slits between an
arm and the body. **🔍 Claude review & sửa** on a finished figure has Claude fix it:

1. Say what is wrong ("chân bị cụt, đứng không vững"), or leave it empty and Claude looks for problems itself.
   The model is the one the card offers for technical models (Opus or Sonnet).
2. The gateway makes a new job (`request.md`: what the figure is, its size and colours, what to fix); the mesh
   worker copies the figure into its `source/` and its picture to `concept.png`, and runs `claude -p` with
   `mesh3d/fix_prompt.md`, at once: it needs no GPU, so it doesn't wait behind figures being made.
3. Claude reads `mesh3d/fix_guide.md` (what goes wrong with these figures, and the toolkit), looks at the
   picture, and writes `fix.py` with `mesh3d/meshkit.py`: cross-sections, wall thickness and close-ups to find
   the problems; smoothing a region, closing gaps (a voxel closing that only adds material, so the surface
   elsewhere keeps its detail), dropping loose bits, primitives joined with manifold3d (a foot, a support), a flat
   sole, a plinth. `python /opt/mesh3d/refine.py fix.py` runs it and writes the STL, the 3MF with every face
   keeping its filament (new material takes the main one), the preview, `views.png` (six sides, which Claude
   reads to check its work) and the report. It repeats until the figure is right, at most 6 runs.
4. The card shows each problem Claude found, fixed (✓) or not (✗), and its notes; **👁 6 phía** and
   **📄 fix.py** open what it looked at and what it did. The figure it fixed stays as it was; a fix can be fixed
   again, and **🎲 Tạo lại** is offered on the figure Hunyuan3D made, not on fixes.

Claude keeps the size, pose and proportions and changes what is broken. What it can't rebuild (a face that came
out flat, a missing arm) it says so in the warnings: a new figure from another picture or seed is the better way
then. A review takes a few minutes and counts against the Claude plan like a technical model; it is stopped
after 20 minutes (`MESH_FIX_TIMEOUT_S`).

### Setup

The host needs an NVIDIA GPU that Docker can use (Docker Desktop with WSL 2 passes it through with `gpus: all`). The image uses PyTorch 2.7 with CUDA 12.8, the first with kernels for RTX 50xx cards.

```bash
docker compose -f docker-compose.mesh3d.yml up -d --build
```

The image is about 15 GB (PyTorch with the CUDA compiler, for the texture stage). The first figure downloads the model weights into `data/mesh3d/models`: about 8 GB for Hunyuan3D-2mini, for the first figure made from a description 14.5 GB for HunyuanDiT, and for the first coloured one 18 GB for Hunyuan3D-Paint. A Hugging Face read token in `HF_TOKEN` (free) makes the downloads faster. Then add to `.env` and restart the gateway:

```env
MESH_WORKER_URL=http://127.0.0.1:3103
```

Hunyuan3D-2 and HunyuanDiT come under Tencent's own licences, which restrict commercial use: read them before selling prints or models made with them.

## Antigravity (MCP)

`cad/mcp/server.mjs` is an MCP server (stdio, no dependencies) that gives an agent the same tools. In Antigravity, the agent writes the build123d code itself, on Antigravity's own plan, and the gateway builds it:

| Tool | What it does |
| --- | --- |
| `cad_guide` | The modelling rules and build123d primer (`cad/guide.md`) |
| `cad_build` | Builds code that assigns `result`: report and preview image back, as a new job (`parent_id` links a revision) |
| `cad_get_job` | One job: state, report, Claude's summary, `model.py` and the preview |
| `cad_list_jobs` | Recent jobs |
| `cad_make_figure` | A figure from a picture on this computer (`image_path`) and/or a description, with Hunyuan3D-2 |
| `cad_fix_figure` | Claude reviews a finished figure and fixes it (`prompt`: what to fix, or nothing) |
| `cad_send_to_studio` | Puts a finished model into Studio's `/imports` |
| `cad_ask_claude` | Hands the request to Claude in the container instead (runs on the Claude subscription) |

Jobs built from Antigravity show up on the dashboard card too, marked **Antigravity / code**.

To add it, open **Manage MCP servers → View raw config** in Antigravity's agent panel (`~/.gemini/antigravity-ide/mcp_config.json`) and add:

```json
{
  "mcpServers": {
    "bambu-cad": {
      "command": "node",
      "args": ["C:/Users/<you>/bambu-lab-h2d/cad/mcp/server.mjs"],
      "env": { "GATEWAY_URL": "http://localhost:3000", "GATEWAY_API_KEY": "" }
    }
  }
}
```

Set `GATEWAY_API_KEY` when the gateway has one. Then ask the agent, for example: "Thiết kế hộp đựng pin AA 4 ngăn bằng bambu-cad, kiểm tra ảnh xem trước rồi gửi sang Studio".

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/cad` | Whether it is set up; for each worker (`worker`, `mesh`, null when not set up) whether it answers and has a Claude token, and whether the figure model is loaded; the models offered |
| GET | `/api/cad/guide` | `cad/guide.md` |
| GET | `/api/cad/jobs?limit=30` | Jobs, newest first |
| POST | `/api/cad/jobs` | `{prompt, model?, parent_id?}`: Claude designs a model, or changes `parent_id`'s. 202 with the job |
| POST | `/api/cad/jobs/:id/fix` | `{prompt?, model?}`: Claude reviews the finished figure `:id` and fixes it, as a new job. 202 with the job; 409 `MODEL_NOT_READY` before the figure is done |
| POST | `/api/cad/meshes` | Multipart with `image` and/or the fields `prompt`, `height_mm` (default 80), `base`, `seed`, `parent_id` (make that figure again), `colour` with `colours` (2–8, default 4) and `palette`: `auto`, `ams`, `bambu` with `material` (a material or `family:PLA`), or `custom` with `filaments` (saved ids, comma-separated), or the same as JSON without a picture: a figure. 202 with the job; 409 `AMS_TOO_FEW_COLOURS` when the AMS holds fewer than two filaments |
| POST | `/api/cad/builds` | `{code, title?, prompt?, parent_id?}`: builds ready-made code now. 201 with the job |
| GET | `/api/cad/jobs/:id` | One job: `state` (queued, running, done, failed, cancelled), `step`, `notes`, `result`, `report`, `files`, `sent` |
| POST | `/api/cad/jobs/:id/cancel` | Stops Claude, or drops a figure from the queue (a figure being made stops at its next step) |
| POST | `/api/cad/jobs/:id/studio` | `{format?: "stl" \| "step" \| "3mf"}`: into Studio's `/imports`, named after the model's title (`3mf`: a coloured figure, painted) |
| GET | `/api/filaments/colors` | Bambu's colour catalogue (`?material=` for one material), its materials and families |
| GET, POST | `/api/filaments/custom` | Filament của tôi: list, or save `{name, brand?, material, hex}` |
| DELETE | `/api/filaments/custom/:id` | Removes a saved filament |
| GET | `/api/cad/jobs/:id/files/:name` | `model.py`, `model.stl`, `model.step`, `preview.png`, `concept.png` (a figure's picture), `model.3mf` (a coloured figure), `report.json`, or a fix's `fix.py` and `views.png`; `?download=1` as an attachment |

## Limits

- build123d suits mechanical parts: boxes, brackets, mounts, enclosures, adapters. Use figures for organic shapes; they in turn have no exact dimensions besides the height.
- Claude checks the model by eye on the preview and by the build report. Check fits and clearances yourself before printing parts that must mate with something.
- A job interrupted by a container restart shows as failed; create it again.
- The container has network access (Claude needs it) and runs model code as an unprivileged user with no capabilities, 4 GB of memory and the job folders as its only shared files.
