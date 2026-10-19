# Gateway-side slicing

The printer only runs sliced G-code. When you upload a `.3mf` **project** that hasn't been sliced, for example a model downloaded from MakerWorld, the gateway can slice it for the H2D with headless Bambu Studio. The same goes for a bare model: `.stl`, `.obj`, `.step` or `.stp` uploads are always sliced with the H2D system presets (0.20mm Standard, Generic PLA) and centered on the plate. You then pick the plate and AMS trays as you would for a normal `.gcode.3mf`.

Slicing is optional. If it isn't enabled, unsliced projects and bare models are rejected with `422 NOT_SLICED`.

## Setup

1. Build the slicer image (Docker required; about 1.3 GB). The Dockerfile pins the Bambu Studio release and checks its sha256:
   ```bash
   docker build -t bambu-h2d-slicer:02.08.02.61 slicer/
   ```
2. Point the gateway at the image in `.env`:
   ```env
   SLICER_DOCKER_IMAGE=bambu-h2d-slicer:02.08.02.61
   SLICER_TIMEOUT_MS=600000
   ```
3. The user running the gateway must be able to run `docker`, for example by being in the `docker` group.

The image runs Bambu Studio in an Ubuntu 22.04 container, so it also works on older hosts such as Ubuntu 20.04, where the AppImage itself won't start.

## How it works

`POST /api/print/prepare` and `POST /api/print/prepare-remote` work as follows:

1. If the file already contains `Metadata/plate_N.gcode`, it is staged as-is and the slicer is never called.
2. Otherwise the gateway runs `slicer/slice.py` in a container:
   - with `--network none`;
   - as the gateway's uid/gid;
   - with only a per-job temp directory mounted;
   - one slice at a time.
   
   The container is killed after `SLICER_TIMEOUT_MS`.
3. `slice.py` picks the settings:
   - **Project made for the H2D:** it is sliced with its own embedded settings, so your supports, infill and other tweaks are kept.
   - **Project made for another printer** (e.g. A1, X1C): the machine, process and filament presets are replaced with the closest H2D system presets.
     - Machine: `Bambu Lab H2D <nozzle> nozzle`. The nozzle is the one reported by the printer, falling back to the project's nozzle, then 0.4.
     - Process: same name, then the same layer height (Standard first), then the H2D default (0.20mm Standard).
     - Build plate: `SLICER_BED_TYPE` if set, otherwise the project's plate, otherwise Textured PEI.
     - Filament: same preset family, then `Generic <type>`, then `Bambu <type> Basic`, then `Generic PLA`.
     
     The Studio CLI only accepts fully resolved presets, so each preset's `inherits` chain and `include` templates (start/end G-code) are flattened first.
4. The output `<name>.gcode.3mf` is staged and later uploaded over FTPS. This also applies to an unsliced file picked from the printer's storage, which is never printed directly.

The staged response includes `slicedByGateway` (source printer, presets used, duration). The dashboard shows it, together with the slicer's warnings such as "floating regions".

## Limits

- Re-targeting a project from another printer resets its process settings to the H2D defaults. If the model needs supports or other custom settings, slice it in Bambu Studio instead.
- Filament presets are chosen from the project's filament types, not from what is loaded in the AMS. Check the tray mapping before you print.
- A large mesh can take minutes to slice, and the prepare request stays open until slicing finishes.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `NOT_SLICED` | 422 | Unsliced project or STL/OBJ/STEP model and `SLICER_DOCKER_IMAGE` is not set |
| `SLICER_UNAVAILABLE` | 500 | `docker` could not be started |
| `SLICE_TIMEOUT` | 504 | Exceeded `SLICER_TIMEOUT_MS` |
| `SLICE_FAILED` | 500 | Bambu Studio reported an error (message included) |
| `SLICER_PROFILE_NOT_FOUND` | 500 | No compatible H2D preset for the requested nozzle or filament |
