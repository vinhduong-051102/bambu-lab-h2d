"""
Mechanism simulation (docs/mechanical-simulation.md): a mechanism described in JSON (schema.py) is checked and
turned into SI numbers in the worker's Python, simulated by Project Chrono in its own Python (chrono_run.py, the
/opt/chrono environment, apart from Hunyuan3D-2's PyTorch), and played back as an animation in Blender
(playback.py). runs.py keeps the mechanisms and the runs, one folder each, under SIM_DIR.
"""
