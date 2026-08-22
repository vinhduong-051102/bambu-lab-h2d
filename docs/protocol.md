# Bambu Lab H2D Telemetry & Protocol Mapping Documentation

This document defines the exact source mapping from real **Bambu Lab H2D MQTT Raw Payloads** (`print`) to the Gateway's normalized `PrinterState`.

---

## 1. Key Architectural Principles for H2D

1. **Dual Nozzles & Independent Extruders**:
   - H2D reports nozzle information in `print.nozzle.info[]` (Nozzles 0 and 1).
   - Extruder status is reported in `print.extruder.info[]`. Extruder motor/body temperatures and parameters (`hnow`, `hpre`, `htar`) are maintained in `extruders[]` independently from nozzle hotend temperatures.
2. **Chamber Temperature Status (`POSSIBLE`)**:
   - Chamber temperature is searched in `print.ctc.info.temp` ➔ `print.info.temp` ➔ `print.chamber_temper`. It is marked with `confidence: "POSSIBLE"` until protocol evidence confirms exact hardware sensors.
3. **Fan Speed Preserved Protocol Names**:
   - Fan values (`cooling_fan_speed`, `big_fan1_speed`, `big_fan2_speed`, `fan`, `fan_gear`) are mapped directly to `fan.cooling`, `fan.bigFan1`, `fan.bigFan2`, `fan.fan`, `fan.fanGear` without unverified renames to `aux` or `chamber`.
4. **HMS Diagnostics**:
   - HMS errors in `print.hms[]` are preserved as objects containing raw `{ attr, code }` for precise error decoding.
5. **No Duplicate Raw Extensions**:
   - `rawExtensions` contains strictly unparsed/unknown top-level fields from `print` payload to eliminate duplicate memory usage.
6. **State Merge & Array Merge by ID**:
   - Incoming partial MQTT telemetry updates are merged into the existing state by ID for arrays (`nozzles`, `extruders`, `ams.trays`), preserving unmentioned fields.

---

## 2. H2D Source-to-Target Field Mapping Matrix

| Normalized Field Path | Exact Raw Payload Path | Confidence Level | Transformation / Logic |
| :--- | :--- | :--- | :--- |
| `state` | `print.gcode_state` | **CONFIRMED** | Uppercase mapping to `'IDLE'`, `'RUNNING'`, `'PAUSED'`, `'FINISHED'`, `'FAILED'` |
| `progress` | `print.mc_percent` | **CONFIRMED** | Rounded integer percentage (0–100) |
| `temperatures.nozzles[].id` | `print.nozzle.info[].id` | **CONFIRMED** | Tool index (`0`, `1`, ...) |
| `temperatures.nozzles[].current` | `print.nozzle.info[].temp` | **CONFIRMED** | Floating point temperature (°C) |
| `temperatures.nozzles[].target` | `print.nozzle.info[].target_temp` | **CONFIRMED** | Target temperature (°C) |
| `temperatures.nozzles[].diameter` | `print.nozzle.info[].diameter` | **CONFIRMED** | Nozzle orifice diameter (e.g. `0.4`) |
| `temperatures.nozzles[].type` | `print.nozzle.info[].type` | **CONFIRMED** | Nozzle material type (e.g. `HS01`) |
| `temperatures.nozzles[].serial` | `print.nozzle.info[].sn` / `serial` | **CONFIRMED** | Nozzle serial string |
| `temperatures.nozzles[].filamentId` | `print.nozzle.info[].fila_id` | **CONFIRMED** | Loaded filament ID |
| `temperatures.nozzles[].state` | `print.nozzle.info[].stat` | **CONFIRMED** | Status code/string |
| `temperatures.nozzles[].wear` | `print.nozzle.info[].wear` | **CONFIRMED** | Nozzle wear metric |
| `extruders[].id` | `print.extruder.info[].id` | **CONFIRMED** | Extruder tool index |
| `extruders[].temp` | `print.extruder.info[].temp` | **CONFIRMED** | Extruder motor/body temperature |
| `extruders[].hnow` | `print.extruder.info[].hnow` | **POSSIBLE** | Raw extruder parameter |
| `extruders[].hpre` | `print.extruder.info[].hpre` | **POSSIBLE** | Raw extruder parameter |
| `extruders[].htar` | `print.extruder.info[].htar` | **POSSIBLE** | Raw extruder parameter (not assumed as targetTemp) |
| `extruders[].state` | `print.extruder.info[].stat` | **CONFIRMED** | Extruder status |
| `temperatures.bed.current` | `print.bed_temper` | **CONFIRMED** | Heatbed temperature (°C) |
| `temperatures.bed.target` | `print.bed_target_temper` | **CONFIRMED** | Target heatbed temperature (°C) |
| `temperatures.chamber.current` | `print.ctc.info.temp` / `print.info.temp` | **POSSIBLE** | Chamber temperature fallback hierarchy |
| `fan.cooling` | `print.cooling_fan_speed` | **CONFIRMED** | Part cooling fan speed percentage |
| `fan.bigFan1` | `print.big_fan1_speed` | **CONFIRMED** | Auxiliary / Big Fan 1 speed |
| `fan.bigFan2` | `print.big_fan2_speed` | **CONFIRMED** | Chamber / Big Fan 2 speed |
| `fan.fan` | `print.fan` | **POSSIBLE** | General fan status |
| `fan.fanGear` | `print.fan_gear` | **POSSIBLE** | Fan gear value |
| `ams[].id` | `print.ams.ams[].id` | **CONFIRMED** | AMS unit ID string |
| `ams[].humidity` | `print.ams.ams[].humidity` | **CONFIRMED** | Parsed humidity index |
| `ams[].humidityRaw` | `print.ams.ams[].humidity_raw` | **CONFIRMED** | Raw humidity index (e.g. `"40"`) |
| `ams[].temperature` | `print.ams.ams[].temp` | **CONFIRMED** | AMS internal temperature (°C) |
| `ams[].trays[].id` | `print.ams.ams[].tray[].id` | **CONFIRMED** | Tray ID string |
| `ams[].trays[].type` | `print.ams.ams[].tray[].tray_type` | **CONFIRMED** | Material code (PETG, PLA...) |
| `ams[].trays[].subBrands` | `print.ams.ams[].tray[].tray_sub_brands` | **CONFIRMED** | Material sub-brand string |
| `ams[].trays[].color` | `print.ams.ams[].tray[].tray_color` | **CONFIRMED** | Hex normalized color `#RRGGBB` (e.g. `#DBC8B6`) |
| `ams[].trays[].rawColor` | `print.ams.ams[].tray[].tray_color` | **CONFIRMED** | Raw color string (e.g. `DBC8B6FF`) |
| `ams[].trays[].remain` | `print.ams.ams[].tray[].remain` | **CONFIRMED** | Spool fill level percentage (0–100%) |
| `hmsErrors[].attr` | `print.hms[].attr` | **CONFIRMED** | Attribute bitmask / category |
| `hmsErrors[].code` | `print.hms[].code` | **CONFIRMED** | Raw integer error code (e.g. `65543`) |
| `rawExtensions` | `print.*` (unparsed fields) | **CONFIRMED** | Preserves all unparsed raw H2D properties without duplicate keys |
