# Bambu Lab H2D Telemetry & Protocol Mapping Documentation

This document defines the exact source mapping from real **Bambu Lab H2D MQTT Raw Payloads** (`print`) to the Gateway's normalized `PrinterState`.

---

## 1. H2D Source-to-Target Field Mapping Matrix

| Normalized Field Path | Exact Raw Payload Path | Confidence Level | Transformation / Logic |
| :--- | :--- | :--- | :--- |
| `state` | `print.gcode_state` | **CONFIRMED** | Uppercase mapping to `'IDLE'`, `'RUNNING'`, `'PAUSED'`, `'FINISHED'`, `'FAILED'` |
| `progress` | `print.mc_percent` | **CONFIRMED** | Rounded integer percentage (0–100) |
| `temperatures.nozzles[i].id` | `print.nozzle.info[i].id` | **CONFIRMED** | String tool ID (`"0"`, `"1"`, ...) |
| `temperatures.nozzles[i].current` | `print.nozzle.info[i].temp` | **CONFIRMED** | Floating point temperature (°C) |
| `temperatures.nozzles[i].target` | `print.nozzle.info[i].target_temp` | **CONFIRMED** | Target temperature (°C) |
| `temperatures.nozzles[i].diameter` | `print.nozzle.info[i].diameter` | **CONFIRMED** | Nozzle orifice diameter in mm (e.g. `0.4`) |
| `temperatures.nozzles[i].type` | `print.nozzle.info[i].type` | **CONFIRMED** | Nozzle material type (e.g. `hardened_steel`) |
| `temperatures.nozzles[i].serial` | `print.nozzle.info[i].serial` | **CONFIRMED** | Nozzle hardware serial number |
| `temperatures.nozzles[i].filamentId` | `print.nozzle.info[i].filament_id` | **CONFIRMED** | Loaded filament ID |
| `temperatures.nozzles[i].state` | `print.nozzle.info[i].state` | **CONFIRMED** | Status string (`ready`, `heating`, etc.) |
| `temperatures.nozzles[i].wear` | `print.nozzle.info[i].wear` | **CONFIRMED** | Nozzle wear metric |
| `extruders[i].id` | `print.extruder.info[i].id` | **CONFIRMED** | Extruder tool index |
| `extruders[i].temp` | `print.extruder.info[i].temp` | **CONFIRMED** | Extruder motor/body temperature |
| `extruders[i].targetTemp` | `print.extruder.info[i].target_temp` | **CONFIRMED** | Extruder target temperature |
| `temperatures.bed.current` | `print.bed_temper` | **CONFIRMED** | Heatbed temperature (°C) |
| `temperatures.bed.target` | `print.bed_target_temper` | **CONFIRMED** | Target heatbed temperature (°C) |
| `temperatures.chamber` | `print.ctc.info.temp` / `print.info.temp` | **POSSIBLE** | Chamber temperature fallback hierarchy |
| `fan.cooling` | `print.cooling_fan_speed` | **CONFIRMED** | Part cooling fan speed percentage |
| `fan.bigFan1` | `print.big_fan1_speed` | **CONFIRMED** | Auxiliary / Big Fan 1 speed |
| `fan.bigFan2` | `print.big_fan2_speed` | **CONFIRMED** | Chamber / Big Fan 2 speed |
| `fan.fan` | `print.fan` | **POSSIBLE** | General fan gear / status |
| `fan.fanGear` | `print.fan_gear` | **POSSIBLE** | Fan gear value |
| `ams[i].id` | `print.ams.ams[i].id` | **CONFIRMED** | AMS unit ID string |
| `ams[i].humidity` | `print.ams.ams[i].humidity` | **CONFIRMED** | Parsed humidity index |
| `ams[i].humidityRaw` | `print.ams.ams[i].humidity_raw` / `humidity` | **CONFIRMED** | Raw humidity index (1–5) |
| `ams[i].temperature` | `print.ams.ams[i].temp` | **CONFIRMED** | AMS internal temperature (°C) |
| `ams[i].filaments[j].id` | `print.ams.ams[i].tray[j].id` | **CONFIRMED** | Tray ID string |
| `ams[i].filaments[j].type` | `print.ams.ams[i].tray[j].tray_type` | **CONFIRMED** | Material code (PLA, PETG, ABS...) |
| `ams[i].filaments[j].subBrands` | `print.ams.ams[i].tray[j].tray_sub_brands` | **CONFIRMED** | Material sub-brand string |
| `ams[i].filaments[j].color` | `print.ams.ams[i].tray[j].tray_color` | **CONFIRMED** | Hex normalized color `#RRGGBB` (e.g. `#DBC8B6`) |
| `ams[i].filaments[j].rawColor` | `print.ams.ams[i].tray[j].tray_color` | **CONFIRMED** | Raw color string (e.g. `DBC8B6FF`) |
| `ams[i].filaments[j].remainingPercentage` | `print.ams.ams[i].tray[j].remain` | **CONFIRMED** | Spool fill level percentage (0–100%) |
| `ams[i].filaments[j].diameter` | `print.ams.ams[i].tray[j].tray_diameter` | **CONFIRMED** | Filament diameter (e.g. 1.75) |
| `ams[i].filaments[j].weight` | `print.ams.ams[i].tray[j].tray_weight` | **CONFIRMED** | Spool weight in grams |
| `ams[i].filaments[j].uuid` | `print.ams.ams[i].tray[j].tray_uuid` | **CONFIRMED** | Spool unique identifier |
| `ams[i].filaments[j].tagUid` | `print.ams.ams[i].tray[j].tag_uid` | **CONFIRMED** | RFID tag UID string |
| `ams[i].filaments[j].infoIdx` | `print.ams.ams[i].tray[j].tray_info_idx` | **CONFIRMED** | Index for filament lookup |
| `hmsErrors[i].attr` | `print.hms[i].attr` | **CONFIRMED** | Attribute bitmask / category |
| `hmsErrors[i].code` | `print.hms[i].code` | **CONFIRMED** | Raw integer error code (e.g. `65543`) |
| `rawExtensions` | `print.*` (unmapped fields) | **CONFIRMED** | Preserves all unmapped raw H2D properties |

---

## 2. Command Protocol Evidence Matrix

| Capability | Read | Write | Status | Topic | Payload / Protocol Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `printer.status` | Yes | No | SUPPORTED | `device/{SERIAL}/report` | Realtime telemetry streaming |
| `print.pause` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "pause"}}` |
| `print.resume` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "resume"}}` |
| `print.stop` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "stop"}}` |
| `temperature.nozzle` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M104 S{target}\n"}}` (T0) |
| `temperature.nozzle2` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M104 T1 S{target}\n"}}` (T1) |
| `temperature.bed` | Yes | Yes | SUPPORTED | `device/{SERIAL}/request` | `{"print": {"sequence_id": "...", "command": "gcode_line", "param": "M140 S{target}\n"}}` |
