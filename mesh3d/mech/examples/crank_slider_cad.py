# A crank-slider as the CAD agent would write it (cad/guide.md, "Assemblies that move"): each part on its own in
# its assembled place, and how it moves. Used by mech/tests/test_viewer.py through cad/build.py.
from build123d import Box, Cylinder, Pos, Rot

r = 30.0       # crank radius (pin to pivot)
L = 100.0      # rod length (pin to pin)
t = 6.0        # link thickness
w = 12.0       # link width

base = Pos(50, 0, -10) * Box(200, 60, 8)
# The crank: a bar from the pivot (origin) to its pin at (r, 0), at z = 0
crank = Pos(r / 2, 0, 0) * Box(r + w, w, t)
# The rod: from the crank pin (r, 0) to the wrist pin (r + L, 0), one layer up
rod = Pos(r + L / 2, 0, t) * Box(L + w, w, t)
# The slider: a block on the wrist pin, guided along X
slider = Pos(r + L, 0, 2 * t) * Box(24, 20, t)

components = {"base": base, "crank": crank, "rod": rod, "slider": slider}
mechanism = {
    "parts": {"base": {"fixed": True, "role": "frame"},
              "crank": {"role": "crank", "material": "pla"},
              "rod": {"role": "rod", "material": "pla"},
              "slider": {"role": "slider", "material": "pla"}},
    "joints": [
        {"id": "crank_pivot", "type": "revolute", "part_a": "base", "part_b": "crank", "position": [0, 0, -3], "axis": [0, 0, 1]},
        {"id": "crank_pin", "type": "revolute", "part_a": "crank", "part_b": "rod", "position": [r, 0, 3], "axis": [0, 0, 1]},
        {"id": "wrist_pin", "type": "revolute", "part_a": "rod", "part_b": "slider", "position": [r + L, 0, 9], "axis": [0, 0, 1]},
        {"id": "slide", "type": "prismatic", "part_a": "base", "part_b": "slider", "position": [r + L, 0, 12], "axis": [1, 0, 0]},
    ],
    "motors": [{"id": "drive", "joint": "crank_pivot", "speed_rpm": 60, "ramp_s": 0.25}],
    "simulation": {"duration": 2, "time_step": 0.0005},
}
# Printed flat, side by side
result = [Pos(0, 0, 4) * Box(200, 60, 8), Pos(0, 50, 3) * Box(r + w, w, t), Pos(0, 80, 3) * Box(L + w, w, t),
          Pos(80, 50, 3) * Box(24, 20, t)]
_ = Rot
