# text-to-cad skills (vendored)

The skills of [text-to-cad](https://github.com/earthtojake/text-to-cad) 0.8.4 (MIT, see LICENSE), copied from its
Claude Code plugin, for Claude in the cad container (`claude --plugin-dir /opt/cad/text-to-cad`, worker.py).
Left out: the MCP server (Claude runs `cadgen` itself), `bambu-labs` and `gcode` (they open Bambu Connect,
Bambu Studio or OrcaSlicer on a desktop; the gateway's own Studio does that). See docs/text-to-cad.md.

To update: copy `skills/` from a newer plugin release, drop those two again, and bump `CADGEN_VERSION` in
cad/Dockerfile to the same release (the skills call `cadgen +<version>`).
