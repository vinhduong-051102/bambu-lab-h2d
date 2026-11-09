"""
The circuit of a model (docs/cad.md, "Mạch điện tử"; electronics.md): the modules a model's `circuit` names, wired as
its nets say, checked and simulated at every build (build.py):

- the rules (ERC): every pin in one net at most, nets of one pin, modules with no power or no ground, two outputs on
  one net, signals driven above what an input takes (5 V into a 3.3 V pin), too weak to read as high;
- ngspice: batteries with their internal resistance, converters and the boards' own regulators (an ideal output, the
  input drawing the output's power over the efficiency), the loads' currents, LEDs, GPIOs as sources, switches and
  protection as resistances, each wire as copper of its length and gauge (wiring.py). Two cases: "avg" (the
  battery at its nominal voltage, every load at its average) and "peak" (the battery nearly empty, every load at its
  worst at once). Then: each power pin within its range, converters within their input range, dropout and current,
  GPIO currents, the battery's current and how long it lasts;
- the wiring diagram (graphviz): schematic.svg and schematic.png, and where graphviz put each part (circuit.json
  `layout`), the start of the dashboard's interactive diagram.

circuit = {"parts": {name: catalogue key}, "nets": {net: ["part.PIN", ...]}, "settings": {"part.setting": value},
           "supplies"?: [{"plus": net, "minus": net, "v": volts, "r": ohms, "name"}], "wiring"?: see wiring.py,
           "internal_ports"?: ["part.port", ...] (ports the case may cover),
           "roles"?: {part: what it does in this circuit} (shown on the dashboard's diagram)}
"""

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from electronics import catalog
from electronics.wiring import net_colour, net_kinds, routes, split, total_length

LEVELS = ("error", "warning", "info")


class Erc:
    def __init__(self):
        self.items = []

    def add(self, level, text):
        if {"level": level, "text": text} not in self.items:
            self.items.append({"level": level, "text": text})


def check_structure(circuit):
    """Raises on a circuit that can't be read; returns {part: spec}"""
    if not isinstance(circuit, dict):
        raise ValueError("`circuit` must be a dict (see electronics.md).")
    parts = circuit.get("parts")
    nets = circuit.get("nets")
    if not isinstance(parts, dict) or not parts:
        raise ValueError('`circuit["parts"]` must be {name: catalogue key}.')
    if not isinstance(nets, dict):
        raise ValueError('`circuit["nets"]` must be {net: ["part.PIN", ...]}.')
    specs = {}
    for name, key in parts.items():
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,40}", str(name)):
            raise ValueError(f"circuit part name {name!r}: letters, digits, _ and - (the part's label in the model).")
        specs[name] = catalog.get(key)
    seen = {}
    for net, members in nets.items():
        if not re.fullmatch(r"[A-Za-z0-9_+.-]{1,32}", str(net)):
            raise ValueError(f"net name {net!r}: letters, digits and _ + . - (at most 32).")
        if not isinstance(members, list) or not all(isinstance(m, str) for m in members):
            raise ValueError(f"circuit net {net!r} must be a list of \"part.PIN\".")
        for ref in members:
            part, pin = split(ref)
            if part not in specs:
                raise ValueError(f"net {net!r}: {part!r} is not in circuit['parts'].")
            if pin not in specs[part]["pins"]:
                raise ValueError(f"net {net!r}: {specs[part]['name']} ({part}) has no pin {pin!r} "
                                 f"(pins: {list(specs[part]['pins'])}).")
            if ref in seen:
                raise ValueError(f"{ref} is in two nets, {seen[ref]!r} and {net!r}: join them into one.")
            seen[ref] = net
    for ref, value in (circuit.get("settings") or {}).items():
        part, setting = split(ref)
        if part not in specs or setting not in (specs[part].get("settings") or {}):
            raise ValueError(f"setting {ref!r}: no such setting (settings: "
                             f"{ {p: list(s.get('settings') or {}) for p, s in specs.items() if s.get('settings')} }).")
        if not isinstance(value, (int, float)):
            raise ValueError(f"setting {ref!r} must be a number.")
    for part, role in (circuit.get("roles") or {}).items():
        if part not in specs or not isinstance(role, str) or len(role) > 300:
            raise ValueError(f"roles[{part!r}]: a part of circuit['parts'] and one sentence (at most 300 characters).")
    return specs


def net_of(circuit):
    return {ref: net for net, members in circuit["nets"].items() for ref in members}


def setting(circuit, part, name, default):
    return (circuit.get("settings") or {}).get(f"{part}.{name}", default)


# --- the netlist ---------------------------------------------------------------------------------------------------


def node(part, pin):
    return re.sub(r"[^a-z0-9_]", "_", f"n_{part}_{pin}".lower().replace("+", "p").replace("-", "m"))


class Netlist:
    def __init__(self):
        self.lines, self.nodes, self.count = [], set(), 0

    def name(self, kind):
        self.count += 1
        return f"{kind}{self.count}"

    def add(self, line, *nodes):
        self.lines.append(line)
        self.nodes.update(n for n in nodes if n != "0")


def ground_ref(circuit, specs):
    """The node every voltage is measured from: the first battery's minus, else the first supply's minus net"""
    for part, spec in specs.items():
        if spec.get("battery"):
            return node(part, spec["battery"]["minus"])
    for supply in circuit.get("supplies") or []:
        members = circuit["nets"].get(supply.get("minus"), [])
        if members:
            return node(*split(members[0]))
    return None


def active_regulator(spec, wired, part):
    reg = spec.get("regulator")
    if not reg:
        return None
    if f"{part}.{reg['in']}" in wired:
        return reg
    return None


def load_node(spec, part, wired, regulator):
    load = spec.get("load")
    if not load:
        return None
    if spec.get("load_on") and (regulator or f"{part}.{spec['load_on']}" in wired):
        return spec["load_on"]
    pins = load["pin"] if isinstance(load["pin"], list) else [load["pin"]]
    return next((p for p in pins if f"{part}.{p}" in wired), None)


def build_netlist(circuit, specs, branches, scenario):
    """(netlist text, what each element is) for one case: "avg" or "peak" """
    nets = net_of(circuit)
    wired = set(nets)
    ref = ground_ref(circuit, specs)
    nl = Netlist()
    elements = {"batteries": {}, "regulators": {}, "loads": {}, "drivers": {}, "passes": {}, "leds": {}, "wires": []}

    def n(part, pin):
        name = node(part, pin)
        return "0" if name == ref else name

    # Wires: each branch a resistance; a net whose pins are not all placed joins them with 1 mΩ
    for net, members in circuit["nets"].items():
        if net in branches:
            for b in branches[net]:
                r = nl.name("rw")
                nl.add(f"{r} {n(*split(b['from']))} {n(*split(b['to']))} {max(b['ohms'], 1e-4):.6g}",
                       n(*split(b["from"])), n(*split(b["to"])))
                elements["wires"].append((r, net, b))
        else:
            for a, b in zip(members, members[1:]):
                nl.add(f"{nl.name('rj')} {n(*split(a))} {n(*split(b))} 1e-3", n(*split(a)), n(*split(b)))

    for part, spec in specs.items():
        # Pins of the same kind on one module are joined on its board (GND, GND_2)
        by_base = {}
        for pin in spec["pins"]:
            by_base.setdefault(catalog.base_pin(pin), []).append(pin)
        for same in by_base.values():
            for a, b in zip(same, same[1:]):
                nl.add(f"{nl.name('rt')} {n(part, a)} {n(part, b)} 1e-3", n(part, a), n(part, b))

        bat = spec.get("battery")
        if bat:
            cells = bat["cells"]
            v = cells * (bat["v_nom"] if scenario == "avg" else bat["v_empty"] + 0.3)
            src = f"vb_{part}".lower()
            inner = node(part, "bat_inner")
            nl.add(f"{src} {inner} {n(part, bat['minus'])} DC {v:.4g}", inner, n(part, bat["minus"]))
            nl.add(f"{nl.name('rb')} {inner} {n(part, bat['plus'])} {cells * bat['r_cell']:.4g}", inner,
                   n(part, bat["plus"]))
            elements["batteries"][part] = src

        for a, b, ohms in spec.get("passes", []):
            r = nl.name("rp")
            nl.add(f"{r} {n(part, a)} {n(part, b)} {ohms:.4g}", n(part, a), n(part, b))
            elements["passes"][f"{part}.{a}-{b}"] = (part, a, b, ohms)

        reg = active_regulator(spec, wired, part)
        if reg:
            vout = setting(circuit, part, "vout", reg["vout"])
            src = f"vr_{part}".lower()
            inner = node(part, "reg_inner")
            out, out_gnd, vin, vin_gnd = n(part, reg["out"]), n(part, reg["out_gnd"]), n(part, reg["in"]), n(part, reg["in_gnd"])
            nl.add(f"{src} {inner} {out_gnd} DC {vout:.4g}", inner, out_gnd)
            nl.add(f"{nl.name('ro')} {inner} {out} 0.02", inner, out)
            if reg["kind"] == "ldo":
                current = f"-i({src})+0.005"
            else:
                current = f"v({out},{out_gnd})*(-i({src}))/({reg['eta']}*max(v({vin},{vin_gnd}),0.5))+0.002"
            nl.add(f"{nl.name('br')} {vin} {vin_gnd} I={current}", vin, vin_gnd)
            if reg["in_gnd"] != reg["out_gnd"]:
                nl.add(f"{nl.name('rg')} {vin_gnd} {out_gnd} 1e-3", vin_gnd, out_gnd)
            elements["regulators"][part] = (src, reg, vout)

        load_pin = load_node(spec, part, wired, reg)
        if load_pin:
            load = spec["load"]
            amps = load["avg"] if scenario == "avg" else load["peak"]
            amps *= setting(circuit, part, "duty", 1.0) if scenario == "avg" else 1.0
            nl.add(f"{nl.name('il')} {n(part, load_pin)} {n(part, load['gnd'])} DC {amps:.4g}",
                   n(part, load_pin), n(part, load["gnd"]))
            elements["loads"][part] = (load_pin, amps)

        led = spec.get("led")
        if led and f"{part}.{led['a']}" in wired:
            vf, r = setting(circuit, part, "vf", led["vf"]), setting(circuit, part, "r", led["r"])
            nl.add(f"{nl.name('bl')} {n(part, led['a'])} {n(part, led['k'])} I=max(v({n(part, led['a'])},"
                   f"{n(part, led['k'])})-{vf},0)/{r}", n(part, led["a"]), n(part, led["k"]))
            elements["leds"][part] = (vf, r)

    # Outputs drive their nets: pure outputs always, GPIOs only on nets with no pure output (else they read it)
    for net, members in circuit["nets"].items():
        outs = [m for m in members if catalog.pin_type(specs[split(m)[0]], split(m)[1])["type"] == "out"]
        drivers = outs or [m for m in members if catalog.pin_type(specs[split(m)[0]], split(m)[1])["type"] == "io"]
        for ref_pin in drivers:
            part, pin = split(ref_pin)
            spec = specs[part]
            t = catalog.pin_type(spec, pin)
            gnd = next((p for p in spec["pins"] if catalog.pin_type(spec, p)["type"] == "gnd"), None)
            if gnd is None:
                continue
            # The level, then a 0 V source that measures what the pin sources, then its output resistance (a
            # pull-up's when the level is another pin's voltage)
            src = f"vd_{part}_{re.sub(r'[^a-z0-9]', '_', pin.lower())}"
            inner = node(part, f"drv_{pin}")
            if isinstance(t.get("logic"), str):
                rout = 4700
                # The pin it follows may be wired to nothing: it is still a node (0 V through its leak)
                nl.add(f"b{src} {inner} {n(part, gnd)} V=v({n(part, t['logic'])},{n(part, gnd)})", inner, n(part, gnd),
                       n(part, t["logic"]))
            else:
                rout = 25
                nl.add(f"vl{src} {inner} {n(part, gnd)} DC {t.get('logic', 3.3)}", inner, n(part, gnd))
            nl.add(f"{src} {inner} {inner}x DC 0", inner, inner + "x")
            nl.add(f"{nl.name('rd')} {inner}x {n(part, pin)} {rout}", inner + "x", n(part, pin))
            elements["drivers"][ref_pin] = src

    for supply in circuit.get("supplies") or []:
        plus = circuit["nets"].get(supply.get("plus"), [])
        minus = circuit["nets"].get(supply.get("minus"), [])
        if plus and minus:
            src = f"vs_{re.sub(r'[^a-z0-9]', '_', str(supply.get('name', 'supply')).lower())}"
            inner = node("supply", supply.get("name", "s"))
            nl.add(f"{src} {inner} {n(*split(minus[0]))} DC {supply['v']}", inner, n(*split(minus[0])))
            nl.add(f"{nl.name('rs')} {inner} {n(*split(plus[0]))} {supply.get('r', 0.1)}", inner, n(*split(plus[0])))
            elements["batteries"][supply.get("name", "supply")] = src

    # Nothing floats: every node has a path to ground
    for nd in sorted(nl.nodes):
        nl.add(f"{nl.name('rleak')} {nd} 0 1e9")
    text = "* circuit.py " + scenario + "\n" + "\n".join(nl.lines) + "\n.control\nop\nprint all\n.endc\n.end\n"
    return text, elements


def run_ngspice(text):
    """{name: value} of the operating point (node voltages as v(node), source currents as source#branch)"""
    if not shutil.which("ngspice"):
        raise RuntimeError("ngspice is not installed here (rebuild the cad image).")
    with tempfile.TemporaryDirectory() as tmp:
        cir = Path(tmp) / "circuit.cir"
        cir.write_text(text)
        proc = subprocess.run(["ngspice", "-b", str(cir)], capture_output=True, text=True, timeout=60)
    values = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"^\s*([\w#().,]+)\s*=\s*([-+0-9.eE]+)\s*$", line)
        if m:
            values[m.group(1).lower()] = float(m.group(2))
    if not values:
        tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-8:])
        raise RuntimeError(f"ngspice found no operating point: {tail}")
    return values


def voltage(values, nd, ref=None):
    def v(x):
        return 0.0 if x in ("0", None) else values.get(f"v({x})", values.get(x, 0.0))
    return v(nd) - (v(ref) if ref else 0.0)


# --- the checks ----------------------------------------------------------------------------------------------------


def gnd_pin(spec):
    return next((p for p in spec["pins"] if catalog.pin_type(spec, p)["type"] == "gnd"), None)


def static_checks(circuit, specs, erc):
    nets = net_of(circuit)
    wired = set(nets)
    for net, members in circuit["nets"].items():
        if len(members) < 2:
            erc.add("warning", f"Net {net} chỉ có một chân ({members[0] if members else '—'}).")
        types = {m: catalog.pin_type(specs[split(m)[0]], split(m)[1])["type"] for m in members}
        outs = [m for m, t in types.items() if t == "out"]
        if len(outs) > 1:
            erc.add("error", f"Net {net}: hai chân xuất tín hiệu nối với nhau ({', '.join(outs)}).")
        if types and set(types.values()) <= {"in"}:
            erc.add("warning", f"Net {net}: chỉ có chân nhận ({', '.join(members)}), không chân nào xuất tín hiệu.")
        if "gnd" in types.values() and set(types.values()) - {"gnd"}:
            others = [m for m, t in types.items() if t != "gnd"]
            erc.add("error", f"Net {net} nối GND với {', '.join(others)}: chập nguồn hoặc sai chân.")
    for part, spec in specs.items():
        if spec.get("load") or spec.get("regulator") and not spec["regulator"].get("onboard"):
            g = gnd_pin(spec)
            if g and not any(f"{part}.{p}" in wired for p in spec["pins"] if catalog.pin_type(spec, p)["type"] == "gnd"):
                erc.add("error", f"{part} ({spec['name']}) chưa nối GND.")
        if spec.get("load"):
            reg = active_regulator(spec, wired, part)
            if not load_node(spec, part, wired, reg):
                pins = spec["load"]["pin"] if isinstance(spec["load"]["pin"], list) else [spec["load"]["pin"]]
                erc.add("error", f"{part} ({spec['name']}) chưa được cấp nguồn (nối một trong {', '.join(pins)}).")
        reg = spec.get("regulator")
        if reg and not reg.get("onboard") and f"{part}.{reg['in']}" in wired and f"{part}.{reg['out']}" not in wired:
            erc.add("warning", f"{part}: ngõ ra {reg['out']} chưa nối đi đâu.")
        if spec.get("notes") and any(r.startswith(part + ".") for r in wired):
            erc.add("info", f"{part}: {spec['notes']}")
    if not any(s.get("battery") for s in specs.values()) and not circuit.get("supplies"):
        erc.add("info", "Mạch không có pin hay nguồn ngoài (circuit['supplies']): không mô phỏng điện.")


def results(circuit, specs, elements, values, scenario, erc):
    """What one case says: each power pin's voltage, the converters', the battery's current; problems into erc"""
    ref_of = {part: node(part, gnd_pin(spec)) if gnd_pin(spec) else None for part, spec in specs.items()}
    ref = ground_ref(circuit, specs)

    def nd(part, pin):
        name = node(part, pin)
        return "0" if name == ref else name

    def pin_v(part, pin):
        return voltage(values, nd(part, pin), None if ref_of[part] == ref else nd(part, gnd_pin(specs[part])))

    label = "trung bình" if scenario == "avg" else "tải đỉnh, pin gần cạn"
    out = {"pins": {}, "regulators": {}, "batteries": {}, "drivers": {}, "leds": {}, "wires": {}}
    wired = set(net_of(circuit))
    for ref_pin in sorted(wired):
        part, pin = split(ref_pin)
        t = catalog.pin_type(specs[part], pin)
        v = pin_v(part, pin)
        out["pins"][ref_pin] = round(v, 3)
        if t["type"] == "power" and "v" in t:
            low, high = t["v"]
            if v > high + 0.05:
                erc.add("error", f"{ref_pin} nhận {v:.2f} V, quá mức {high} V ({label}).")
            elif v < low - 0.05 and v > 0.2:
                erc.add("error" if scenario == "avg" else "warning",
                        f"{ref_pin} chỉ còn {v:.2f} V, dưới mức {low} V ({label}).")
            elif v <= 0.2 and specs[part].get("load"):
                erc.add("error", f"{ref_pin} không có điện ({label}): kiểm tra đường nguồn.")
    for part, (src, reg, vout) in elements["regulators"].items():
        i_out = -values.get(f"{src}#branch", 0.0)
        vin = pin_v(part, reg["in"])
        p_out = vout * i_out
        p_in = p_out / reg["eta"] if reg.get("eta") else vin * (i_out + 0.005)
        out["regulators"][part] = {"vin": round(vin, 3), "vout": vout, "iout": round(i_out, 4),
                                   "loss_w": round(max(p_in - p_out, 0), 3)}
        name = f"{part} ({specs[part]['name']})"
        low, high = reg["vin"]
        if vin > high + 0.05:
            erc.add("error", f"{name}: điện áp vào {vin:.2f} V quá mức {high} V ({label}).")
        if reg["kind"] in ("buck", "ldo") and vin < vout + reg["dropout"] - 0.01:
            erc.add("error" if scenario == "avg" else "warning",
                    f"{name}: vào {vin:.2f} V không đủ để ra {vout} V (cần ≥ {vout + reg['dropout']:.2f} V, {label}).")
        if reg["kind"] == "boost" and vin >= vout:
            erc.add("error", f"{name}: mạch tăng áp nhưng vào {vin:.2f} V ≥ ra {vout} V.")
        if i_out > reg["imax"] + 1e-6:
            erc.add("error" if scenario == "avg" else "warning",
                    f"{name}: dòng ra {i_out:.2f} A vượt {reg['imax']} A ({label}).")
        elif scenario == "avg" and i_out > 0.8 * reg["imax"]:
            erc.add("warning", f"{name}: dòng ra trung bình {i_out:.2f} A gần mức tối đa {reg['imax']} A.")
        if reg["kind"] == "ldo" and out["regulators"][part]["loss_w"] > 1.0:
            erc.add("warning", f"{name}: ổn áp tuyến tính tỏa {out['regulators'][part]['loss_w']:.1f} W, sẽ rất nóng.")
    for part, src in elements["batteries"].items():
        i = -values.get(f"{src}#branch", 0.0)
        out["batteries"][part] = {"current_a": round(i, 4)}
    for ref_pin, src in elements["drivers"].items():
        part, pin = split(ref_pin)
        t = catalog.pin_type(specs[part], pin)
        i = values.get(f"{src}#branch", 0.0)
        out["drivers"][ref_pin] = round(i, 5)
        imax = t.get("imax")
        if imax and i > imax + 1e-4:
            erc.add("error", f"{ref_pin} phải cấp {i * 1000:.0f} mA, quá {imax * 1000:.0f} mA của chân "
                             "(dùng transistor/MOSFET hoặc tăng điện trở).")
    for part, (vf, r) in elements["leds"].items():
        led = specs[part]["led"]
        v = voltage(values, nd(part, led["a"]), nd(part, led["k"]))
        out["leds"][part] = round(max(v - vf, 0) / r, 5)
        if scenario == "avg" and out["leds"][part] > 0.03:
            erc.add("warning", f"{part}: LED chạy {out['leds'][part] * 1000:.0f} mA, nên ≤ 20 mA (tăng điện trở).")
    for r, net, b in elements["wires"]:
        drop = abs(voltage(values, nd(*split(b["from"])), nd(*split(b["to"]))))
        amps = drop / max(b["ohms"], 1e-4)
        out["wires"].setdefault(net, 0.0)
        out["wires"][net] = round(max(out["wires"][net], amps), 4)
        limit = {16: 10, 18: 7, 20: 5, 22: 3, 24: 2, 26: 1.3, 28: 0.8}[b["gauge"]]
        if amps > limit:
            erc.add("warning", f"Dây {net} ({b['from']}→{b['to']}) mang {amps:.1f} A, quá sức dây AWG{b['gauge']} "
                               f"(~{limit} A): dùng dây to hơn (wiring.nets).")
    for key, (part, a, b, ohms) in elements["passes"].items():
        amps = abs(voltage(values, nd(part, a), nd(part, b))) / ohms
        limit = (specs[part].get("limits") or {}).get(a) or (specs[part].get("limits") or {}).get(b)
        if limit and amps > limit:
            erc.add("warning", f"{part}: {amps:.1f} A qua {a}–{b}, quá {limit} A ({label}).")
    return out


def level_checks(circuit, specs, sims, erc):
    """Signals against the inputs they reach, with the voltages of the average case"""
    pins = sims.get("avg", {}).get("pins", {})
    for net, members in circuit["nets"].items():
        highs = {}
        for ref_pin in members:
            part, pin = split(ref_pin)
            t = catalog.pin_type(specs[part], pin)
            if t["type"] in ("out", "io") and "logic" in t:
                level = t["logic"]
                if isinstance(level, str):
                    level = pins.get(f"{part}.{level}")
                if level is not None:
                    highs[ref_pin] = level
        for ref_pin in members:
            part, pin = split(ref_pin)
            t = catalog.pin_type(specs[part], pin)
            if t["type"] not in ("in", "io"):
                continue
            for driver, level in highs.items():
                if driver == ref_pin:
                    continue
                if "max" in t and level > t["max"] + 0.05:
                    erc.add("error", f"Net {net}: {driver} lên {level:.1f} V nhưng {ref_pin} chỉ chịu {t['max']} V "
                                     "(dùng cầu chia áp hoặc mạch chuyển mức).")
                if t.get("vih") and level < t["vih"]:
                    erc.add("warning", f"Net {net}: {driver} chỉ lên {level:.1f} V, {ref_pin} cần ≥ {t['vih']} V để "
                                       "nhận mức cao (dùng mạch chuyển mức).")


def battery_life(circuit, specs, sims):
    out = {}
    avg = sims.get("avg", {}).get("batteries", {})
    for part, spec in specs.items():
        bat = spec.get("battery")
        if bat and part in avg and avg[part]["current_a"] > 1e-4:
            hours = bat["mah"] / 1000 * 0.8 / avg[part]["current_a"]
            out[part] = {"mah": bat["mah"], "cells": bat["cells"], "current_a": avg[part]["current_a"],
                         "hours": round(hours, 1)}
    return out


# --- the diagram ---------------------------------------------------------------------------------------------------


def dot_text(circuit, specs, branches, colours):
    wired = net_of(circuit)
    lines = ["graph circuit {", '  graph [rankdir=LR, splines=true, nodesep=0.5, ranksep=1.2, fontname="DejaVu Sans"];',
             '  node [shape=record, fontname="DejaVu Sans", fontsize=10, style=filled, fillcolor="#f7f7f7"];',
             '  edge [fontname="DejaVu Sans", fontsize=9, penwidth=2];']
    order = {"battery": 0, "charger": 1, "switch": 2, "converter": 3, "mcu": 4}
    for part, spec in sorted(specs.items(), key=lambda kv: order.get(kv[1]["kind"], 5)):
        pins = [p for p in spec["pins"] if f"{part}.{p}" in wired]
        ports = "|".join(f"<{node('', p)}> {p}" for p in pins) or " "
        title = spec["name"].replace('"', "'").replace("|", "/").replace("{", "(").replace("}", ")")
        lines.append(f'  {node(part, "")} [label="{{ {part}\\n{title} | {{ {ports} }} }}"];')
    for net, members in circuit["nets"].items():
        pairs = ([(b["from"], b["to"]) for b in branches[net]] if net in branches
                 else list(zip(members, members[1:])))
        for k, (a, b) in enumerate(pairs):
            (pa, na), (pb, nb) = split(a), split(b)
            label = f', label="{net}"' if k == 0 else ""
            lines.append(f'  {node(pa, "")}:{node("", na)} -- {node(pb, "")}:{node("", nb)} '
                         f'[color="{colours[net]}"{label}];')
    lines.append("}")
    return "\n".join(lines)


def layout(dot, parts):
    """{part: [x, y]}: the centre of each part in graphviz's drawing, in points from its top left; {} without graphviz"""
    if not shutil.which("dot"):
        return {}
    proc = subprocess.run(["dot", "-Tjson0"], input=dot, text=True, capture_output=True, timeout=60)
    if proc.returncode != 0:
        return {}
    graph = json.loads(proc.stdout)
    height = float(graph["bb"].split(",")[3])
    names = {node(part, ""): part for part in parts}
    placed = {}
    for obj in graph.get("objects", []):
        if obj.get("name") in names and "pos" in obj:
            x, y = (float(v) for v in obj["pos"].split(","))
            placed[names[obj["name"]]] = [round(x, 1), round(height - y, 1)]
    return placed


def draw(dot, out):
    if not shutil.which("dot"):
        return []
    files = []
    for fmt in ("svg", "png"):
        target = out / f"schematic.{fmt}"
        # dpi only for the PNG: in an SVG graphviz scales the drawing and its size but not the viewBox,
        # which then shows only the top-left part
        dpi = ["-Gdpi=110"] if fmt == "png" else []
        proc = subprocess.run(["dot", f"-T{fmt}", *dpi, "-o", str(target)], input=dot, text=True,
                              capture_output=True, timeout=60)
        if proc.returncode == 0:
            files.append(target.name)
    return files


# --- the whole -----------------------------------------------------------------------------------------------------


def analyse(circuit, shapes, out=None):
    """circuit.json's content for a model's `circuit`; `shapes` are the placed parts by label (for wire lengths).
    With `out`, writes circuit.json, circuit-<case>.cir and the diagram there"""
    specs = check_structure(circuit)
    erc = Erc()
    static_checks(circuit, specs, erc)
    placed = {name: shapes[name] for name in specs if name in shapes}
    missing = [name for name in specs if name not in shapes]
    if missing and shapes:
        erc.add("warning", f"Không thấy trong mô hình: {', '.join(missing)} (đặt module bằng electronics.module "
                           "với đúng tên này): dây của chúng không được tính độ dài.")
    branches = routes(circuit, placed)
    kinds = net_kinds(circuit)
    colours = {net: net_colour(circuit, net, k, kinds) for k, net in enumerate(circuit["nets"])}

    sims, sim_error = {}, None
    if ground_ref(circuit, specs):
        for scenario in ("avg", "peak"):
            text, elements = build_netlist(circuit, specs, branches, scenario)
            if out is not None:
                (out / f"circuit-{scenario}.cir").write_text(text)
            try:
                values = run_ngspice(text)
            except (RuntimeError, subprocess.TimeoutExpired) as err:
                sim_error = str(err)
                break
            sims[scenario] = results(circuit, specs, elements, values, scenario, erc)
        if sims:
            level_checks(circuit, specs, sims, erc)
    if sim_error:
        erc.add("warning", f"Không mô phỏng được: {sim_error}")

    wired = net_of(circuit)
    roles = circuit.get("roles") or {}
    wires = {}
    for net, bs in branches.items():
        wires[net] = {"length_mm": round(total_length(bs), 1), "gauge": bs[0]["gauge"], "branches": bs}
    bom = {}
    for part, key in circuit["parts"].items():
        bom.setdefault(key, {"key": key, "name": specs[part]["name"], "parts": []})["parts"].append(part)
    by_gauge = {}
    for w in wires.values():
        by_gauge[w["gauge"]] = by_gauge.get(w["gauge"], 0) + w["length_mm"]
    report = {
        "parts": {part: {"key": circuit["parts"][part], "name": spec["name"], "kind": spec["kind"],
                         "placed": part in placed,
                         # The wired pins in the catalogue's order, and what Claude says the part is for
                         "pins": [p for p in spec["pins"] if f"{part}.{p}" in wired],
                         **({"role": roles[part]} if part in roles else {}),
                         **({"notes": spec["notes"]} if spec.get("notes") else {})}
                  for part, spec in specs.items()},
        "nets": {net: {"pins": members, "kind": kinds[net], "colour": colours[net],
                       "length_mm": wires.get(net, {}).get("length_mm")} for net, members in circuit["nets"].items()},
        "bom": [{"name": b["name"], "key": b["key"], "count": len(b["parts"]), "parts": b["parts"]} for b in bom.values()]
               + [{"name": f"Dây AWG{g}", "key": f"wire_awg{g}", "length_mm": round(length * 1.2, 0),
                   "note": "độ dài theo đường đi trong mô hình, cộng 20 %"} for g, length in sorted(by_gauge.items())],
        "wires": wires,
        "simulation": {"ok": bool(sims) and not sim_error, "cases": sims, "battery": battery_life(circuit, specs, sims),
                       "error": sim_error},
        "erc": sorted(erc.items, key=lambda e: LEVELS.index(e["level"])),
        "files": [],
        "layout": {},
    }
    if out is not None:
        dot = dot_text(circuit, specs, branches, colours)
        report["files"] = draw(dot, out)
        report["layout"] = layout(dot, specs)
        (out / "circuit.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    return report


def summary_warnings(report):
    """The lines of report.json's warnings for Claude: the errors and warnings of the check"""
    return [f"Mạch: {e['text']}" for e in report["erc"] if e["level"] in ("error", "warning")]


if __name__ == "__main__":
    import sys

    data = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps(analyse(data, {}), indent=2, ensure_ascii=False))
