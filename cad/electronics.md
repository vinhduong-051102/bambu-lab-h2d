# Electronics in a model

When the request has electronics in it (a controller, a battery, a servo, LEDs, a sensor, a display…), design the
circuit and the printed parts together: off-the-shelf modules from the catalogue, wired as a `circuit`, placed in
the model with the case built around them. Every build checks and simulates the circuit and looks at how the modules
sit in the case; the user sees all of it in the CAD Viewer (modules and wires in colour, the case see-through or
exploded) and the dashboard's ⚡ Mạch điện section. build.py draws the printed parts see-through in the GLB, the CAD
Viewer and assembly.png by itself: give the case its colour as usual, no alpha. It also writes each half on its own
(out/electronics.glb/.step/.png: every part that is not printed; out/case.glb/.step/.png: the printed parts), so the
user can look at and download the circuit and the case apart: keep the modules and wires as parts of the assembly
with their own labels (never fused into the case); anything bought that is not in `circuit` (a placeholder board)
lands with the electronics.

## The catalogue

`python -m electronics` lists the modules: key, name, board size, ports and pins. Read `/opt/cad/electronics/catalog.py`
for a module's exact frame (pins, holes, ports, electrical data). Use only modules in it; when the request needs one
it doesn't have, take the nearest and say so in the assumptions (or model a bought part from step.parts, which the
circuit then can't simulate).

A module's frame: X along its length, Y across, Z up, origin at the centre of the bottom of its board (a servo, a
holder: of its body). Ports (USB, a switch's toggle, a screen, a sensor's eyes, a servo's shaft) face along their
`dir`.

## The model

```python
import build123d as bd
from cadgen import model
from electronics import cradle, module, port_cutout, standoffs, wires

circuit = {
    "parts": {"bat": "holder_18650_2s", "sw": "switch_mts102", "buck": "mini360", "mcu": "esp32_devkitc"},
    "nets": {
        "VBAT": ["bat.+", "sw.COM"],
        "VSW": ["sw.NO", "buck.IN+"],
        "5V": ["buck.OUT+", "mcu.5V"],
        "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND"],
    },
    "settings": {"buck.vout": 5.0},
}

@model
def control_box():
    mcu = module("esp32_devkitc", "mcu", bd.Pos(-15, 26, 6))
    ...
    case -= port_cutout(mcu, "usb")
    case += cradle(mcu, floor_z=2)
    return bd.Compound(children=[case, mcu, ..., *wires(circuit, [mcu, ...])])
```

The whole of it is `/opt/cad/examples/electronics_box.py`: start from it.

- `circuit` at module level: `parts` {name: catalogue key}, `nets` {net: ["part.PIN", …]} (every pin in one net at
  most), `settings` {"part.setting": number} (a converter's `vout`, an LED's `r` and `vf`, a load's `duty`, 0–1 of the
  time it runs, for the average), optional `supplies` [{"plus": net, "minus": net, "v": 5.0, "r": 0.1, "name":
  "USB"}] for power from outside (a USB charger, a wall adapter) when there is no battery, optional `wiring` (below)
  and `internal_ports` ["part.port"] for ports the case may cover on purpose.
- `roles` {part: one sentence}: what each part does in this circuit, in the user's language ("Hạ 7.4 V của pin
  xuống 5 V cho riêng hai servo"). The dashboard shows it on hovering the part in the wiring diagram: give every part
  one.
- `module(key, name, location)`: the module as a part labelled `name`, the name in `circuit["parts"]`. Place it only
  by its location (`bd.Pos(...) * bd.Rot(...)`, in the call or by multiplying), never by booleans, and put it straight
  into the assembly's children (not in a sub-assembly): its pins and ports are read from where it is.
- The case holds each module: `standoffs(m, floor_z)` (posts with pilot holes under its mounting holes, for boards
  that have them), `cradle(m, floor_z)` (ledges and corner guides, for boards without), or a pocket of your own (a
  battery holder screws or sits in a recess). Both helpers need the module level (turned about Z only).
- Each port the user must reach gets `case -= port_cutout(m, "usb")`: the opening with 0.4 mm clearance through
  whatever is in front of it. Panel parts (switch, LED) sit behind a wall 2–6 mm thick with their port through it.
- `wires(circuit, modules)`: one part per net (`wire_<net>`), routed up from each pin, across at 5 mm above the higher
  pin and down; ground black, the battery's + red, power orange-red, signals in colours. `circuit["wiring"]`:
  `{"gauge": 24, "lift": 5.0, "nets": {"VBAT": {"gauge": 20, "z": 25.0, "first": "y"}}}` (AWG, mm above the higher
  pin, an absolute height, which way it turns first) when a wire runs into the case or a module.
- Modules and wires are left off the print by themselves; only the case and the other printed parts are laid out.

## What the build checks

After each build read `out/circuit.json` (and look at `out/schematic.png`, the wiring diagram) as you read the
preview. report.json's warnings carry its errors and warnings, as `Mạch: …` and `Lắp ráp: …`:

- **Mạch**: modules with no power or no ground, nets of one pin, two outputs on one net, signals above what an
  input takes (an HC-SR04's 5 V Echo into an ESP32), too low to read as high (3.3 V into a WS2812 at 5 V), power
  pins out of their range, converters below their dropout or above their current, GPIOs sourcing too much (an LED
  without enough resistance), wires too thin for their current. ngspice computes it twice: `avg` (battery at its
  nominal voltage, loads at their average) and `peak` (battery nearly empty, every load at its worst at once, a servo
  stalled).
- **Lắp ráp**: a module or a wire running into a printed part, a port with the case in front of it.

Fix them as you would a geometry problem: change the circuit (a level shifter, a divider, another converter, a
resistor, a separate supply for servos), move a module, give a wire another height. Something the catalogue can't
model (a voltage divider of two resistors, a level shifter, a capacitor) goes into the summary as what the user must
add, with its values; say there that the simulation does not include it.

## Rules

- One ground for everything; servos and LED strips from their own converter, not from a board's 3.3 V or 5 V pin.
- A 2S pack is charged by a 2S charger, not a TP4056 (which is for 1S): say so, or use 1S with a boost converter.
- Leave 1 mm around boards, 3 mm over the tallest part, room for the wires to bend (10 mm at a connector), vents over
  a converter that loses more than 0.5 W (circuit.json `regulators.*.loss_w`).
- The modules' sizes are typical of the clones: in the summary, ask the user to measure the real module before a
  snug fit.
- Mention in the summary how to wire it (the nets, in Vietnamese), the battery life the simulation gives, and the
  Li-ion safety basics (a protected cell or a BMS, no charging unattended in a closed box).
