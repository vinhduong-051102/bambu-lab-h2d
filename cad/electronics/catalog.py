"""
Off-the-shelf modules a model can hold (docs/cad.md, "Mạch điện tử"): their size, mounting holes, ports and pins for
the model, and how they behave electrically for circuit.py.

Every module has its own frame: X along its length, Y across, Z up; the origin at the centre of the board's bottom
face (a servo's or a battery holder's: the centre of its bottom). Lengths are millimetres, from the makers' drawings
where there are some and measured boards where not: the common clones differ by a few tenths, so a snug fit wants
the real module measured.

A module:
  name, kind              what it is: mcu, battery, charger, converter, actuator, sensor, display, switch, led
  board                   (length, width, thickness) of its PCB, or None
  color                   the PCB's colour (sRGB)
  blocks                  [(x, y, z, length, width, height, colour)]: what stands on it, each a box from its
                          bottom centre (x, y, z)
  cylinders               [(x, y, z, diameter, height, colour)]: round parts, upright from (x, y, z)
  holes                   [(x, y, diameter)]: mounting holes through the board (or flange)
  ports                   {name: {"at": (x, y, z) the centre of its outer face, "dir": outward (x, y, z),
                          "size": (width, height) across dir, "shape": rect | round, "access": whether the case
                          must leave it reachable}}
  pins                    {name: (x, y, z)} where a wire meets the pin; the same name with _2, _3… is another pin
                          of the same kind (a second GND)
  pin_types               {name without _n: {"type": gnd | power | io | in | out, "v": (min, max) a power pin
                          takes, "logic": the high level an output drives (a number, or the name of the module's
                          pin whose voltage it is, for pull-ups to VCC), "max": the most an input takes,
                          "imax": the most an output sources (A)}}
  load                    {"pin": the power pin (or pins, the first that is wired), "gnd", "avg", "peak"}: the
                          current it draws (A), on average and at worst (a servo stalled, LEDs all white)
  regulator               {"in", "in_gnd", "out", "out_gnd", "kind": buck | boost | ldo, "vout", "vin": (min, max),
                          "dropout", "eta", "imax"}: a converter, or a board's own regulator
  battery                 {"plus", "minus", "cells", "v_full", "v_nom", "v_empty", "mah", "r_cell"}
  passes                  [(pin, pin, ohms)]: pins joined inside it (a switch closed, a charger's protection)
  led                     {"a", "k", "vf", "r"}: an LED with its series resistor (ohms)
"""

PITCH = 2.54
PIN_Z = 1.0  # a wire meets a board's pin this far above the board's top face
GREEN, BLUE, BLACK, METAL = "#1d5e3a", "#1f4e8c", "#222222", "#b8b8b8"


def row(names, x0, y, z, pitch=PITCH, along="x"):
    """{name: (x, y, z)} of a header row from (x0, y) every `pitch` mm; a name given again gets _2, _3…"""
    out, seen = {}, {}
    for k, name in enumerate(names):
        seen[name] = seen.get(name, 0) + 1
        key = name if seen[name] == 1 else f"{name}_{seen[name]}"
        pos = (x0 + k * pitch, y) if along == "x" else (y, x0 + k * pitch)
        out[key] = (round(pos[0], 3), round(pos[1], 3), z)
    return out


def centred_row(names, y, z, pitch=PITCH):
    return row(names, -(len(names) - 1) * pitch / 2, y, z, pitch)


def io(logic=3.3, max_in=3.6, imax=0.02):
    return {"type": "io", "logic": logic, "max": max_in, "imax": imax}


GND = {"type": "gnd"}

ESP32_LEFT = ["3V3", "EN", "GPIO36", "GPIO39", "GPIO34", "GPIO35", "GPIO32", "GPIO33", "GPIO25", "GPIO26", "GPIO27",
              "GPIO14", "GPIO12", "GND", "GPIO13", "GPIO9", "GPIO10", "GPIO11", "5V"]
ESP32_RIGHT = ["GND", "GPIO23", "GPIO22", "GPIO1", "GPIO3", "GPIO21", "GND", "GPIO19", "GPIO18", "GPIO5", "GPIO17",
               "GPIO16", "GPIO4", "GPIO0", "GPIO2", "GPIO15", "GPIO8", "GPIO7", "GPIO6"]
NANO_TOP = ["D13", "3V3", "AREF", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "5V", "RST", "GND", "VIN"]
NANO_BOTTOM = ["D12", "D11", "D10", "D9", "D8", "D7", "D6", "D5", "D4", "D3", "D2", "GND", "RST", "RX0", "TX1"]
PICO_LEFT = ["GP0", "GP1", "GND", "GP2", "GP3", "GP4", "GP5", "GND", "GP6", "GP7", "GP8", "GP9", "GND", "GP10", "GP11",
             "GP12", "GP13", "GND", "GP14", "GP15"]
PICO_RIGHT = ["VBUS", "VSYS", "GND", "3V3_EN", "3V3", "ADC_VREF", "GP28", "GND", "GP27", "GP26", "RUN", "GP22", "GND",
              "GP21", "GP20", "GP19", "GP18", "GND", "GP17", "GP16"]


def esp32_types(names):
    types = {n: io() for n in names if n.startswith("GPIO")}
    for n in ("GPIO34", "GPIO35", "GPIO36", "GPIO39"):  # input only
        types[n] = {"type": "in", "max": 3.6}
    types.update({"3V3": {"type": "power", "v": (3.0, 3.6)}, "5V": {"type": "power", "v": (4.5, 5.5)}, "GND": GND,
                  "EN": {"type": "in", "max": 3.6}})
    return types


def servo(name, body, flange, flange_z, holes_dx, shaft_dx, top, v, avg, peak):
    """A hobby servo: body (length, width, height), the flange with its two holes, the output shaft towards +X,
    the cable out of the -X end"""
    length, width, height = body
    return {
        "name": name, "kind": "actuator", "board": None, "color": BLUE,
        "blocks": [(0, 0, 0, length, width, height, BLUE), (0, 0, flange_z, flange, width, 2.5, BLUE)],
        "cylinders": [(shaft_dx, 0, height, top, 2.0, BLUE), (shaft_dx, 0, height + 2.0, 4.8, 3.5, "#f2f2f2")],
        "holes": [(-holes_dx / 2, 0, 2.2), (holes_dx / 2, 0, 2.2)],
        "ports": {"shaft": {"at": (shaft_dx, 0, height + 5.5), "dir": (0, 0, 1), "size": (top + 1, top + 1),
                            "shape": "round", "access": True},
                  "cable": {"at": (-length / 2, 0, 4.0), "dir": (-1, 0, 0), "size": (4.0, 1.6), "shape": "rect",
                            "access": False}},
        "pins": {"GND": (-length / 2 - 1.0, -1.3, 4.0), "V+": (-length / 2 - 1.0, 0.0, 4.0),
                 "SIG": (-length / 2 - 1.0, 1.3, 4.0)},
        "pin_types": {"GND": GND, "V+": {"type": "power", "v": v}, "SIG": {"type": "in", "max": 6.0}},
        "load": {"pin": "V+", "gnd": "GND", "avg": avg, "peak": peak},
    }


def holder_18650(cells):
    width = 21.0 * cells
    ys = [(-(cells - 1) / 2 + k) * 21.0 for k in range(cells)]
    return {
        "name": f"Hộp pin 18650 {cells}S (nối tiếp)", "kind": "battery", "board": None, "color": BLACK,
        "blocks": [(0, 0, 0, 77.0, width, 2.0, BLACK), (-37.5, 0, 0, 2.0, width, 18.6, BLACK),
                   (37.5, 0, 0, 2.0, width, 18.6, BLACK)],
        "cylinders": [],
        "cells": [(y, "#3a7bd5") for y in ys],
        "holes": [(-25.0, 0, 3.2), (25.0, 0, 3.2)],
        "ports": {},
        "pins": {"+": (38.5, ys[-1], 3.0), "-": (38.5 if cells % 2 == 0 else -38.5, ys[0], 3.0)},
        "pin_types": {"+": {"type": "power", "v": (0, 30)}, "-": GND},
        "battery": {"plus": "+", "minus": "-", "cells": cells, "v_full": 4.2, "v_nom": 3.7, "v_empty": 3.0,
                    "mah": 2600, "r_cell": 0.06},
    }


def converter(name, kind, board, holes, vout, vin, dropout, eta, imax, pots=()):
    length, width, thick = board
    return {
        "name": name, "kind": "converter", "board": board, "color": BLUE,
        "blocks": [(0, 0, thick, length * 0.35, width * 0.5, 4.0, BLACK)]
                  + [(x, y, thick, 9.5, 4.5, 6.0, "#2a62c9") for x, y in pots],
        "cylinders": [],
        "holes": holes,
        "ports": {},
        "pins": {"IN+": (-length / 2 + 1.5, width / 2 - 1.5, thick + PIN_Z),
                 "IN-": (-length / 2 + 1.5, -width / 2 + 1.5, thick + PIN_Z),
                 "OUT+": (length / 2 - 1.5, width / 2 - 1.5, thick + PIN_Z),
                 "OUT-": (length / 2 - 1.5, -width / 2 + 1.5, thick + PIN_Z)},
        "pin_types": {"IN+": {"type": "power", "v": vin}, "IN-": GND, "OUT+": {"type": "power", "v": (0, 40)},
                      "OUT-": GND},
        "regulator": {"in": "IN+", "in_gnd": "IN-", "out": "OUT+", "out_gnd": "OUT-", "kind": kind, "vout": vout,
                      "vin": vin, "dropout": dropout, "eta": eta, "imax": imax},
        "settings": {"vout": "điện áp ra (V), chỉnh bằng biến trở"},
    }


T = 1.6  # common PCB thickness

MODULES = {
    "esp32_devkitc": {
        "name": "ESP32-DevKitC V4", "kind": "mcu", "board": (54.4, 27.9, T), "color": GREEN,
        "blocks": [(12.0, 0, T, 25.5, 18.0, 3.2, METAL), (-17.0, 0, T, 6.0, 6.0, 2.0, BLACK)],
        "cylinders": [],
        "holes": [],
        "ports": {"usb": {"at": (-27.2 - 0.8, 0, T + 1.5), "dir": (-1, 0, 0), "size": (8.0, 3.0), "shape": "rect",
                          "access": True}},
        "pins": {**row(ESP32_LEFT, -22.86, 12.7, T + PIN_Z), **row(ESP32_RIGHT, -22.86, -12.7, T + PIN_Z)},
        "pin_types": esp32_types(ESP32_LEFT + ESP32_RIGHT),
        "load": {"pin": ["5V", "3V3"], "gnd": "GND", "avg": 0.08, "peak": 0.35},
        "regulator": {"in": "5V", "in_gnd": "GND", "out": "3V3", "out_gnd": "GND", "kind": "ldo", "vout": 3.3,
                      "vin": (4.5, 6.0), "dropout": 1.1, "eta": None, "imax": 0.8, "onboard": True},
        "load_on": "3V3",
    },
    "esp32_c3_supermini": {
        "name": "ESP32-C3 SuperMini", "kind": "mcu", "board": (22.5, 18.0, T), "color": BLACK,
        "blocks": [(2.5, 0, T, 9.0, 9.0, 1.0, METAL)],
        "cylinders": [],
        "holes": [],
        "ports": {"usb": {"at": (-11.25 - 0.6, 0, T + 1.6), "dir": (-1, 0, 0), "size": (9.2, 3.4), "shape": "rect",
                          "access": True}},
        "pins": {**row(["5V", "GND", "3V3", "GPIO4", "GPIO3", "GPIO2", "GPIO1", "GPIO0"], -8.89, 7.62, T + PIN_Z),
                 **row(["GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO20", "GPIO21"], -8.89, -7.62,
                       T + PIN_Z)},
        "pin_types": {**{f"GPIO{n}": io() for n in (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21)},
                      "3V3": {"type": "power", "v": (3.0, 3.6)}, "5V": {"type": "power", "v": (4.5, 5.5)}, "GND": GND},
        "load": {"pin": ["5V", "3V3"], "gnd": "GND", "avg": 0.05, "peak": 0.35},
        "regulator": {"in": "5V", "in_gnd": "GND", "out": "3V3", "out_gnd": "GND", "kind": "ldo", "vout": 3.3,
                      "vin": (4.5, 6.0), "dropout": 0.3, "eta": None, "imax": 0.5, "onboard": True},
        "load_on": "3V3",
    },
    "arduino_nano": {
        "name": "Arduino Nano (ATmega328P)", "kind": "mcu", "board": (43.2, 18.5, T), "color": BLUE,
        "blocks": [(3.0, 0, T, 7.0, 7.0, 1.0, BLACK), (-17.5, 0, T, 9.0, 7.5, 4.0, METAL)],
        "cylinders": [],
        "holes": [(-20.0, 7.6, 1.6), (-20.0, -7.6, 1.6), (20.0, 7.6, 1.6), (20.0, -7.6, 1.6)],
        "ports": {"usb": {"at": (-21.6 - 1.4, 0, T + 2.0), "dir": (-1, 0, 0), "size": (8.0, 4.0), "shape": "rect",
                          "access": True}},
        "pins": {**row(NANO_TOP, -17.78, 7.62, T + PIN_Z), **row(NANO_BOTTOM, -17.78, -7.62, T + PIN_Z)},
        "pin_types": {**{n: io(5.0, 5.5, 0.02) for n in NANO_TOP + NANO_BOTTOM if n[0] in "DA" and n != "AREF"},
                      "RX0": io(5.0, 5.5), "TX1": io(5.0, 5.5), "AREF": {"type": "in", "max": 5.5},
                      "RST": {"type": "in", "max": 5.5}, "3V3": {"type": "power", "v": (3.0, 3.6)},
                      "5V": {"type": "power", "v": (4.5, 5.5)}, "VIN": {"type": "power", "v": (7.0, 12.0)},
                      "GND": GND},
        "load": {"pin": ["VIN", "5V"], "gnd": "GND", "avg": 0.03, "peak": 0.06},
        "regulator": {"in": "VIN", "in_gnd": "GND", "out": "5V", "out_gnd": "GND", "kind": "ldo", "vout": 5.0,
                      "vin": (6.5, 12.0), "dropout": 1.2, "eta": None, "imax": 0.5, "onboard": True},
        "load_on": "5V",
    },
    "rpi_pico": {
        "name": "Raspberry Pi Pico", "kind": "mcu", "board": (51.0, 21.0, 1.0), "color": GREEN,
        "blocks": [(0, 0, 1.0, 7.0, 7.0, 0.9, BLACK)],
        "cylinders": [],
        "holes": [(-23.5, 5.7, 2.1), (-23.5, -5.7, 2.1), (23.5, 5.7, 2.1), (23.5, -5.7, 2.1)],
        "ports": {"usb": {"at": (-25.5 - 1.3, 0, 1.0 + 1.5), "dir": (-1, 0, 0), "size": (8.0, 3.0), "shape": "rect",
                          "access": True}},
        "pins": {**row(PICO_LEFT, -24.13, -8.89, 1.0 + PIN_Z), **row(PICO_RIGHT, -24.13, 8.89, 1.0 + PIN_Z)},
        "pin_types": {**{n: io() for n in PICO_LEFT + PICO_RIGHT if n.startswith("GP")},
                      "VBUS": {"type": "power", "v": (4.5, 5.5)}, "VSYS": {"type": "power", "v": (1.8, 5.5)},
                      "3V3": {"type": "power", "v": (3.0, 3.6)}, "3V3_EN": {"type": "in", "max": 5.5},
                      "ADC_VREF": {"type": "in", "max": 3.6}, "RUN": {"type": "in", "max": 3.6}, "GND": GND},
        "load": {"pin": ["VSYS", "VBUS", "3V3"], "gnd": "GND", "avg": 0.025, "peak": 0.1},
        "regulator": {"in": "VSYS", "in_gnd": "GND", "out": "3V3", "out_gnd": "GND", "kind": "buck", "vout": 3.3,
                      "vin": (1.8, 5.5), "dropout": 0.0, "eta": 0.85, "imax": 0.3, "onboard": True},
        "load_on": "3V3",
    },
    "sg90": servo("Servo SG90 (9 g)", (22.8, 12.2, 22.7), 32.2, 15.9, 27.8, 5.6, 11.8, (4.8, 6.0), 0.15, 0.65),
    "mg996r": servo("Servo MG996R", (40.7, 19.7, 37.0), 54.5, 26.5, 49.5, 10.0, 19.7, (4.8, 7.2), 0.5, 2.5),
    "holder_18650_1s": holder_18650(1),
    "holder_18650_2s": holder_18650(2),
    "tp4056_usbc": {
        "name": "Mạch sạc TP4056 USB-C (có bảo vệ)", "kind": "charger", "board": (28.0, 17.0, T), "color": BLUE,
        "blocks": [(-11.0, 0, T, 7.5, 9.0, 3.2, METAL), (2.0, 0, T, 5.0, 4.0, 1.5, BLACK)],
        "cylinders": [],
        "holes": [],
        "ports": {"usb": {"at": (-14.0 - 0.5, 0, T + 1.6), "dir": (-1, 0, 0), "size": (9.2, 3.4), "shape": "rect",
                          "access": True},
                  "leds": {"at": (-4.0, 0, T + 0.5), "dir": (0, 0, 1), "size": (4.0, 6.0), "shape": "rect",
                           "access": False}},
        "pins": {"B+": (12.5, 5.5, T + PIN_Z), "B-": (12.5, -5.5, T + PIN_Z), "OUT+": (12.5, 2.0, T + PIN_Z),
                 "OUT-": (12.5, -2.0, T + PIN_Z)},
        "pin_types": {"B+": {"type": "power", "v": (2.5, 4.3)}, "B-": GND, "OUT+": {"type": "power", "v": (0, 4.3)},
                      "OUT-": GND},
        "passes": [("B+", "OUT+", 0.02), ("B-", "OUT-", 0.05)],
        "limits": {"OUT+": 3.0},
        "notes": "Sạc 1 cell Li-ion (4.2 V), 1 A. Không dùng cho pin 2S nối tiếp.",
    },
    "mt3608": converter("Mạch tăng áp MT3608", "boost", (36.0, 17.0, T), [], 5.0, (2.0, 24.0), 0.0, 0.88, 1.0,
                        pots=[(-6.0, 3.5)]),
    "lm2596": converter("Mạch hạ áp LM2596", "buck", (43.0, 21.0, T),
                        [(-15.0, 7.5, 3.0), (15.0, -7.5, 3.0)], 5.0, (4.5, 40.0), 1.5, 0.82, 2.0,
                        pots=[(-12.0, -4.0)]),
    "mini360": converter("Mạch hạ áp Mini-360 (MP2307)", "buck", (17.0, 11.0, T), [], 5.0, (4.75, 23.0), 1.0, 0.9,
                         1.8, pots=[(3.5, 0.0)]),
    "switch_mts102": {
        "name": "Công tắc gạt MTS-102 (bắt panel Ø6)", "kind": "switch", "board": None, "color": "#d8d8d8",
        "blocks": [(0, 0, 0, 13.0, 8.0, 10.0, "#d8d8d8")],
        "cylinders": [(0, 0, 10.0, 6.0, 9.0, METAL), (0, 0, 19.0, 2.5, 10.0, METAL)],
        "holes": [],
        "ports": {"toggle": {"at": (0, 0, 10.0), "dir": (0, 0, 1), "size": (6.0, 6.0), "shape": "round",
                             "access": True}},
        "pins": {"COM": (0, 0, -1.0), "NO": (4.7, 0, -1.0), "NC": (-4.7, 0, -1.0)},
        "pin_types": {"COM": {"type": "power", "v": (0, 120)}, "NO": {"type": "power", "v": (0, 120)},
                      "NC": {"type": "power", "v": (0, 120)}},
        "passes": [("COM", "NO", 0.02)],
        "limits": {"COM": 6.0},
        "notes": "Panel 2-6 mm: khoét lỗ Ø6.2 trên vỏ (port toggle), thân nằm dưới mặt panel.",
    },
    "led_5mm": {
        "name": "LED 5 mm (kèm điện trở)", "kind": "led", "board": None, "color": "#e53935",
        "blocks": [],
        "cylinders": [(0, 0, 0, 5.8, 1.0, "#e53935"), (0, 0, 1.0, 5.0, 7.6, "#e53935")],
        "holes": [],
        "ports": {"lens": {"at": (0, 0, 8.6), "dir": (0, 0, 1), "size": (5.0, 5.0), "shape": "round",
                           "access": True}},
        "pins": {"A": (1.27, 0, -2.0), "K": (-1.27, 0, -2.0)},
        "pin_types": {"A": {"type": "in", "max": 30}, "K": GND},
        "led": {"a": "A", "k": "K", "vf": 2.0, "r": 220.0},
        "settings": {"r": "điện trở nối tiếp (Ω)", "vf": "sụt áp LED (V): đỏ 2.0, xanh lá/xanh dương/trắng 3.0"},
    },
    "ws2812_ring12": {
        "name": "Vòng LED WS2812 12 bóng", "kind": "led", "board": (37.0, 37.0, T), "color": BLACK, "round": 23.0,
        "blocks": [(0, 15.0, T, 5.0, 5.0, 1.6, "#f2f2f2")],
        "cylinders": [],
        "holes": [],
        "ports": {"light": {"at": (0, 0, T + 1.6), "dir": (0, 0, 1), "size": (37.0, 37.0), "shape": "round",
                            "access": True}},
        "pins": {"5V": (-4.0, -15.0, -PIN_Z), "GND": (-1.3, -15.0, -PIN_Z), "DIN": (1.3, -15.0, -PIN_Z),
                 "DOUT": (4.0, -15.0, -PIN_Z)},
        "pin_types": {"5V": {"type": "power", "v": (3.5, 5.5)}, "GND": GND,
                      "DIN": {"type": "in", "max": 5.5, "vih": 3.5}, "DOUT": {"type": "out", "logic": "5V"}},
        "load": {"pin": "5V", "gnd": "GND", "avg": 0.15, "peak": 0.72},
        "notes": "DIN cần mức cao ≥ 0.7·VDD (3.5 V khi nuôi 5 V): ESP32/Pico 3.3 V có thể chập chờn.",
    },
    "oled_096_i2c": {
        "name": "Màn OLED 0.96\" I2C (SSD1306)", "kind": "display", "board": (27.3, 27.8, T), "color": BLUE,
        "blocks": [(0, -1.0, T, 26.0, 19.0, 1.5, BLACK)],
        "cylinders": [],
        "holes": [(-11.75, 11.9, 2.2), (11.75, 11.9, 2.2), (-11.75, -11.9, 2.2), (11.75, -11.9, 2.2)],
        "ports": {"screen": {"at": (0, -1.0, T + 1.5), "dir": (0, 0, 1), "size": (22.0, 11.5), "shape": "rect",
                             "access": True}},
        "pins": centred_row(["GND", "VCC", "SCL", "SDA"], 12.0, -PIN_Z),
        "pin_types": {"GND": GND, "VCC": {"type": "power", "v": (3.0, 5.5)},
                      "SCL": {"type": "io", "logic": "VCC", "max": 5.5}, "SDA": {"type": "io", "logic": "VCC", "max": 5.5}},
        "load": {"pin": "VCC", "gnd": "GND", "avg": 0.012, "peak": 0.025},
        "notes": "Điện trở kéo lên của SCL/SDA nối VCC: nuôi 5 V thì chân I2C của vi điều khiển 3.3 V thấy 5 V.",
    },
    "hc_sr04": {
        "name": "Cảm biến siêu âm HC-SR04", "kind": "sensor", "board": (45.0, 20.0, T), "color": BLUE,
        "blocks": [],
        "cylinders": [(-13.0, 0, T, 16.0, 12.0, METAL), (13.0, 0, T, 16.0, 12.0, METAL)],
        "holes": [(-21.0, 8.5, 1.8), (21.0, 8.5, 1.8), (-21.0, -8.5, 1.8), (21.0, -8.5, 1.8)],
        "ports": {"eyes": {"at": (0, 0, T + 12.0), "dir": (0, 0, 1), "size": (43.0, 16.5), "shape": "rect",
                           "access": True}},
        "pins": centred_row(["VCC", "Trig", "Echo", "GND"], -8.5, -PIN_Z),
        "pin_types": {"VCC": {"type": "power", "v": (4.5, 5.5)}, "GND": GND, "Trig": {"type": "in", "max": 5.5},
                      "Echo": {"type": "out", "logic": "VCC"}},
        "load": {"pin": "VCC", "gnd": "GND", "avg": 0.015, "peak": 0.02},
        "notes": "Echo ra 5 V: vào ESP32/Pico cần cầu chia áp (ví dụ 1 kΩ / 2 kΩ).",
    },
}


def get(key):
    try:
        return MODULES[key]
    except KeyError:
        raise ValueError(f"No module {key!r} in the catalogue: {sorted(MODULES)}.") from None


def base_pin(name):
    """GND_2 → GND"""
    head, _, tail = name.rpartition("_")
    return head if head and tail.isdigit() else name


def pin_type(spec, pin):
    return spec["pin_types"].get(base_pin(pin)) or spec["pin_types"].get(pin) or {"type": "io"}


def describe():
    """One line per module, for Claude (`python -m electronics`)"""
    lines = []
    for key, spec in MODULES.items():
        size = spec["board"] or "—"
        pins = ", ".join(spec["pins"])
        lines.append(f"{key}: {spec['name']} [{spec['kind']}] board {size}; ports {list(spec['ports'])}; pins {pins}")
    return "\n".join(lines)
