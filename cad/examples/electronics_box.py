"""A control box: an ESP32 on 2 × 18650, through a switch and a 5 V buck converter (electronics.md)"""

import build123d as bd
from cadgen import model

from electronics import cradle, module, port_cutout, wires

INNER = (94.0, 90.0)  # inside of the box (X, Y)
WALL = 2.0            # walls and floor
HEIGHT = 32.0         # outer height (open top: the lid is another part)
LIFT = 4.0            # boards sit this far above the floor, on their cradles

circuit = {
    "parts": {"bat": "holder_18650_2s", "sw": "switch_mts102", "buck": "mini360", "mcu": "esp32_devkitc"},
    "nets": {
        "VBAT": ["bat.+", "sw.COM"],
        "VSW": ["sw.NO", "buck.IN+"],
        "5V": ["buck.OUT+", "mcu.5V"],
        "GND": ["bat.-", "buck.IN-", "buck.OUT-", "mcu.GND"],
    },
    "settings": {"buck.vout": 5.0},
    "roles": {
        "bat": "Nguồn chính: hai cell 18650 nối tiếp, khoảng 7.4 V.",
        "sw": "Bật/tắt toàn mạch, ngắt dây dương từ pin.",
        "buck": "Hạ 7.4 V của pin xuống 5 V cho ESP32.",
        "mcu": "Bộ điều khiển: chạy chương trình, tự hạ 5 V xuống 3.3 V cho chip.",
    },
}


@model
def control_box():
    floor = WALL
    bat = module("holder_18650_2s", "bat", bd.Pos(0, -20, floor))
    mcu = module("esp32_devkitc", "mcu", bd.Pos(-15, 26, floor + LIFT))
    buck = module("mini360", "buck", bd.Pos(30, 26, floor + LIFT))
    # Panel-mounted in the +X wall, the toggle pointing out of it
    sw = module("switch_mts102", "sw", bd.Pos(INNER[0] / 2 - 10.0, 10, 18) * bd.Rot(0, 90, 0))

    outer = bd.Box(INNER[0] + 2 * WALL, INNER[1] + 2 * WALL, HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    hollow = bd.Pos(0, 0, WALL) * bd.Box(INNER[0], INNER[1], HEIGHT, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))
    case = outer - hollow
    case += cradle(mcu, floor) + cradle(buck, floor)
    case -= port_cutout(mcu, "usb") + port_cutout(sw, "toggle")
    case.label = "case"
    case.color = "#4a6fa5"
    return bd.Compound(children=[case, bat, mcu, buck, sw, *wires(circuit, [bat, mcu, buck, sw])])
