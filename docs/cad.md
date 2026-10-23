# AI model design

The dashboard's **Thiết kế mô hình bằng AI** card turns a description ("giá đỡ điện thoại nghiêng 60°, rộng 80 mm, dày 3 mm") into a model ready to print. Claude writes the model as [build123d](https://build123d.readthedocs.io) Python code, builds it, looks at a preview, fixes what is off, and hands back STL, STEP, the code and a short summary. Antigravity can design models with the same tools through an MCP server.

Everything runs in its own container, `cad` (`docker-compose.cad.yml`): the model code is untrusted, and Claude runs commands while it works. The gateway only stores jobs and passes them on.

Without this setup, the card stays hidden.

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

## Antigravity (MCP)

`cad/mcp/server.mjs` is an MCP server (stdio, no dependencies) that gives an agent the same tools. In Antigravity, the agent writes the build123d code itself, on Antigravity's own plan, and the gateway builds it:

| Tool | What it does |
| --- | --- |
| `cad_guide` | The modelling rules and build123d primer (`cad/guide.md`) |
| `cad_build` | Builds code that assigns `result`: report and preview image back, as a new job (`parent_id` links a revision) |
| `cad_get_job` | One job: state, report, Claude's summary, `model.py` and the preview |
| `cad_list_jobs` | Recent jobs |
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
| GET | `/api/cad` | Whether it is set up, whether the worker answers and has a Claude token, the models offered |
| GET | `/api/cad/guide` | `cad/guide.md` |
| GET | `/api/cad/jobs?limit=30` | Jobs, newest first |
| POST | `/api/cad/jobs` | `{prompt, model?, parent_id?}`: Claude designs a model, or changes `parent_id`'s. 202 with the job |
| POST | `/api/cad/builds` | `{code, title?, prompt?, parent_id?}`: builds ready-made code now. 201 with the job |
| GET | `/api/cad/jobs/:id` | One job: `state` (queued, running, done, failed, cancelled), `step`, `notes`, `result`, `report`, `files`, `sent` |
| POST | `/api/cad/jobs/:id/cancel` | Stops Claude |
| POST | `/api/cad/jobs/:id/studio` | `{format?: "stl" \| "step"}`: into Studio's `/imports`, named after the model's title |
| GET | `/api/cad/jobs/:id/files/:name` | `model.py`, `model.stl`, `model.step`, `preview.png` or `report.json`; `?download=1` as an attachment |

## Limits

- build123d suits mechanical parts: boxes, brackets, mounts, enclosures, adapters. Organic shapes (figures, sculptures) come out crude.
- Claude checks the model by eye on the preview and by the build report. Check fits and clearances yourself before printing parts that must mate with something.
- A job interrupted by a container restart shows as failed; create it again.
- The container has network access (Claude needs it) and runs model code as an unprivileged user with no capabilities, 4 GB of memory and the job folders as its only shared files.
