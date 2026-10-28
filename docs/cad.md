# AI model design

The dashboard's **Thiết kế mô hình bằng AI** card turns a description ("giá đỡ điện thoại nghiêng 60°, rộng 80 mm, dày 3 mm") into a model ready to print. Claude writes the model as [build123d](https://build123d.readthedocs.io) Python code, builds it, looks at a preview, fixes what is off, and hands back STL, STEP, the code and a short summary. Antigravity can design models with the same tools through an MCP server.

Characters, animals, statues and other organic shapes, which build123d can't make, come from a second container, `mesh3d` ([Figures](#figures-nhân-vật--trang-trí)): from a picture, Tencent's Hunyuan3D-2 shapes them on the NVIDIA GPU and Claude finishes them in Blender through [MCP for Blender](https://github.com/ahujasid/blender-mcp); from a description, Claude makes them there.

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

Pick **🧸 Nhân vật / trang trí** on the card. Claude works in a real Blender, as a 3D artist would:

```
                 the request
               /             \
         a picture        a description
             |                  |
   Hunyuan3D-2 on the GPU   Claude chooses: generate_3d (Hunyuan3D-2, organic)
   (Dựng nhiều góc: 4 sides)        or Python in Blender (mechanical)
               \             /
          the Blender scene (MCP for Blender)
                      |
     look from every side, measure, fix, plinth, colours
                      |
        check (the export's print check), export
```

**From a picture.** The job queues for the GPU (`mesh3d/shape.py`, one at a time):

1. **Tách nền ảnh**: rembg cuts the subject out of the picture (**🖼 Ảnh gốc** shows it).
2. **Dựng nhiều góc** (optional): the figure seen from four sides, so the back is not guessed from one picture:
   the sides you upload (**Trái**, **Sau**, **Phải**), or else MV-Adapter (SDXL) draws them from the front
   (~1–2 minutes, nearly all of a 16 GB GPU). **🧭 4 góc** shows them.
3. **Dựng hình 3D từ ảnh**: Hunyuan3D-2mini (one picture) or Hunyuan3D-2mv (four sides), turbo, 5 denoising
   steps, with the seed. Loading a model the first time after a while takes ~1 minute.
4. **Sửa lưới, chỉnh kích thước**: duplicate and broken faces, floating specks, holes; Z up, the height asked,
   on the plate; kept as `source/` (its preview is the **Hunyuan3D dựng** picture beside the result). With colour,
   every face takes the picture's colour where the camera saw it (`mesh3d/picture.py`, a depth test hides what
   is behind; the back from the nearest seen face, or from the back view with four sides).
5. **Claude finishes it** in Blender (`mesh3d/finish_prompt.md`): fixes what stops it printing (feet cut off,
   specks, sheets, slits), adds the plinth, chooses the filaments for the picture's main colours and paints each
   face in the nearest one, then corrects what came out wrong (shadows, eyes), and checks it. It keeps the AI's
   shape, which is what makes it look like the picture.

**From a description.** Claude makes it from nothing (`mesh3d/create_prompt.md`): `generate_3d` for organic forms
(HunyuanDiT draws a picture from Claude's English prompt, Hunyuan3D-2 shapes it), Python for mechanical ones, or
both together.

**How Claude works in Blender.** Each run starts its own Blender 4.5 with its interface on a virtual display
(`xvfb-run`; the add-on's server needs Blender's main loop, which `blender -b` does not have), set up by
`mesh3d/blender_session.py`: 1 unit = 1 mm, Z up, front towards −Y, the job's figure loaded as **Figure**, the
add-on serving on a free port with its local Hunyuan3D-2 on. `claude -p` (`mesh3d/review.py`) gets two MCP
servers and the guide `mesh3d/figure_guide.md`:

- **`blender`**, MCP for Blender (`mcp-for-blender` 2.2.4): `execute_blender_code` (Python in Blender),
  `generate_3d` (one object from the worker's `POST /generate`, which runs Hunyuan3D-2 on the same GPU queue),
  `look` (the scene as an image: several sides, solid or material shading), `get_scene_info`. Its asset libraries
  (Poly Haven, Sketchfab), other generators and telemetry are off; Blender gets no Claude token.
- **`figure`** (`mesh3d/figure_mcp.py`): `set_palette` (the filaments as materials F1…Fn), `paint_from_picture`,
  and `check`: exports what is visible in the scene (modifiers applied, each face's filament from its F<n>
  material) and runs the print check (`mesh3d/refine.py`), with the six sides in colour.

When Claude is done the scene is exported the same way: `out/model.stl`, `out/model.3mf` with every face painted,
the preview, `views.png` and the report, and the scene itself as `out/scene.blend` (**⬇ Blender**). A run takes
5–15 minutes and counts against the Claude plan like a technical model (the model chosen on the card); it is
stopped after 20 minutes (`MESH_FIX_TIMEOUT_S`) or 100 turns.

### Colour

With **Tô màu**, the figure is printed in several filaments (the AMS changes them while printing), up to the
number chosen (2–8):

- **Tự chọn màu theo ảnh**: Claude chooses the colours that suit the picture (one per main colour of it) or the
  description.
- **Màu đang nạp trong AMS**: exactly the filaments loaded in the AMS, in the order Studio lists them after syncing
  (unit by unit, slot by slot, empty slots left out), so filament *n* of the 3MF is tray *n*.
- **Màu Bambu chính hãng**: Claude picks from Bambu's own colours of one material (e.g. PLA Basic) or a whole
  family (**Mọi dòng PLA**), named with their spool codes, from Bambu Studio's `filaments_color_codes.json`
  (downloaded once into `data/bambu/`).
- **Filament của tôi**: from the filaments you saved under **🎨 Filament của tôi** (other brands, or colours Bambu
  doesn't make; kept in `data/filaments/custom.json`), the ticked ones.
- **Ưu tiên màu có sẵn**: the AMS's first, then yours, then Bambu's to buy; the palette says which is which.

`out/model.3mf` holds the mesh with every triangle painted (Bambu's `paint_color`: paint state *n* is filament *n*
in Studio). **📤 Gửi sang Studio (có màu)** sends it; in Studio, set filaments 1–n to the colours the card lists,
or sync the AMS when the colours came from it.

The result has an STL (and with colour a 3MF), a preview and the Blender scene, no STEP. **🎲 Tạo lại** makes
it again from the same picture (and sides) or description, size, plinth and colours: from a picture with another
seed, so another shape.

### Claude review & sửa

A figure can still come out wrong: a part too thin, feet that do not stand, a seam, a colour in the wrong place.
**🔍 Claude review & sửa** on a finished figure has Claude fix it:

1. Say what is wrong ("chân bị cụt, đứng không vững"), or leave it empty and Claude looks for problems itself.
   The model is the one the card offers (Opus or Sonnet).
2. The gateway makes a new job (`request.md`: what the figure is, its size and colours, what to fix); the mesh
   worker copies the figure into its `source/` and its picture to `concept.png`, and Claude
   (`mesh3d/fix_prompt.md`) works on it in Blender as above: the figure is **Figure**, its filaments the
   materials F1…Fn.
3. The fix is a new version of the same model: the list shows one card per model, with a strip of its versions
   (v1 Gốc, v2 Claude sửa, …: fixes, revisions and remakes, oldest first; the newest shown until another is
   picked). A version made from another shows that one's preview beside its own, **Trước** and **Sau**. The card
   shows each problem Claude found, fixed (✓) or not (✗), and its notes; **👁 6 phía** opens the sides Claude
   checked. The figure it fixed stays as it was; a fix can be fixed again, and **🎲 Tạo lại** is offered on the
   figure as first made, not on fixes. 🗑 deletes one version (the ones made from it move up to its parent),
   **Xóa cả nhóm** the model with all its versions (`DELETE /api/cad/jobs/:id[?family=1]`).

Claude keeps the size, pose and proportions and changes what is broken. What it can't rebuild (a face that came
out flat, a missing arm) it says so in the warnings: making the figure again (another seed, **Dựng nhiều góc**)
is the better way then.

### Setup

The host needs an NVIDIA GPU with ~16 GB (an RTX 5070 Ti or better; "Dựng nhiều góc" uses nearly all of it), and
Docker passing it through (`gpus: all`; Docker Desktop with WSL 2 does).

```bash
docker compose -f docker-compose.mesh3d.yml up -d --build
```

The image is about 31 GB: PyTorch 2.7 with CUDA 12.8 (the first with RTX 50xx kernels), Hunyuan3D-2, MV-Adapter,
Blender 4.5 LTS with Xvfb and Mesa, MCP for Blender and Claude Code. The models (Hunyuan3D-2mini, Hunyuan3D-2mv,
HunyuanDiT, MV-Adapter with SDXL, the background remover, ~25 GB) download on first use into `MESH_MODELS_DIR`
(a volume, so they survive rebuilds; put it on a roomy drive); `HF_TOKEN` makes the downloads faster. Models leave
the GPU after 10 minutes without a job (`MESH_IDLE_UNLOAD_S`). It needs `CLAUDE_CODE_OAUTH_TOKEN`
(`claude setup-token`; `CLAUDE_CODE_OAUTH_TOKEN_FALLBACK` for a second subscription). Then add to `.env` and
restart the gateway:

```env
MESH_WORKER_URL=http://127.0.0.1:3103
MESH_MODELS_DIR=F:/bambu-lab-h2d/mesh3d-models
```

Hunyuan3D-2, HunyuanDiT and MV-Adapter's SDXL are under their makers' licences (Tencent's restricts commercial
use); MCP for Blender is MIT.

## Antigravity (MCP)

`cad/mcp/server.mjs` is an MCP server (stdio, no dependencies) that gives an agent the same tools. In Antigravity, the agent writes the build123d code itself, on Antigravity's own plan, and the gateway builds it:

| Tool | What it does |
| --- | --- |
| `cad_guide` | The modelling rules and build123d primer (`cad/guide.md`) |
| `cad_build` | Builds code that assigns `result`: report and preview image back, as a new job (`parent_id` links a revision) |
| `cad_get_job` | One job: state, report, Claude's summary, `model.py` and the preview |
| `cad_list_jobs` | Recent jobs |
| `cad_make_figure` | A figure from a picture on this computer (`image_path`, Hunyuan3D-2 then Claude; `multiview`, `seed`) and/or a description (Claude in Blender) |
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
| POST | `/api/cad/meshes` | Multipart with `image` (and its other sides `image_left`, `image_back`, `image_right`) and/or the fields `prompt`, `height_mm` (default 80), `base`, `model` (the Claude model), `seed`, `multiview`, `parent_id` (make that figure again), `colour` with `colours` (2–8, default 4) and `palette`: `auto`, `ams`, `bambu` with `material` (a material or `family:PLA`), or `custom` with `filaments` (saved ids, comma-separated), or the same as JSON without a picture: a figure. 202 with the job; 409 `AMS_TOO_FEW_COLOURS` when the AMS holds fewer than two filaments |
| POST | `/api/cad/builds` | `{code, title?, prompt?, parent_id?}`: builds ready-made code now. 201 with the job |
| GET | `/api/cad/jobs/:id` | One job: `state` (queued, running, done, failed, cancelled), `step`, `notes`, `result`, `report`, `files`, `sent` |
| POST | `/api/cad/jobs/:id/cancel` | Stops Claude, or drops a figure from the GPU queue (one being shaped stops at its next step) |
| POST | `/api/cad/jobs/:id/studio` | `{format?: "stl" \| "step" \| "3mf"}`: into Studio's `/imports`, named after the model's title (`3mf`: a coloured figure, painted) |
| GET | `/api/filaments/colors` | Bambu's colour catalogue (`?material=` for one material), its materials and families |
| GET, POST | `/api/filaments/custom` | Filament của tôi: list, or save `{name, brand?, material, hex}` |
| DELETE | `/api/filaments/custom/:id` | Removes a saved filament |
| DELETE | `/api/cad/jobs/:id` | Deletes a model; `?family=1` also every fix, revision and remake made from it. 409 `JOB_BUSY` while one of them is being made |
| GET | `/api/cad/jobs/:id/files/:name` | `model.py`, `model.stl`, `model.step`, `preview.png`, `concept.png` (a figure's picture), `model.3mf` (a coloured figure), `report.json`, `views.png`, `sides.png`, `shaped.png` (as Hunyuan3D shaped it), `scene.blend`, or an older fix's `fix.py`; `?download=1` as an attachment |

## Limits

- build123d suits mechanical parts: boxes, brackets, mounts, enclosures, adapters. Use figures for organic shapes; they in turn have no exact dimensions besides the height.
- Claude checks the model by eye on the preview and by the build report. Check fits and clearances yourself before printing parts that must mate with something.
- A job interrupted by a container restart shows as failed; create it again.
- The container has network access (Claude needs it) and runs model code as an unprivileged user with no capabilities, 4 GB of memory and the job folders as its only shared files.
