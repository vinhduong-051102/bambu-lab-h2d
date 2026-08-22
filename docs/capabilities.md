# Bambu Lab Gateway Capability Registry & Evidence

This document lists supported capabilities in the `bambu-h2d-gateway`.

---

## 1. Capability Status Summary

| Capability Key | Description | Status | Evidence / Notes |
| :--- | :--- | :--- | :--- |
| `printer.status` | Read printer state, progress & layers | **SUPPORTED** | Real-time MQTT telemetry normalization |
| `temperature.nozzles` | Dynamic multi-nozzle telemetry (`NozzleState[]`) | **SUPPORTED** | Parsed from `print.nozzle.info[]` (Dual-nozzle H2D) |
| `temperature.bed` | Heatbed temperature monitoring & control | **SUPPORTED** | `print.bed_temper` and `M140 S{target}` |
| `temperature.chamber` | Chamber temperature telemetry | **POSSIBLE** | Read from `print.ctc.info.temp` fallback hierarchy |
| `extruders` | Extruder state monitoring (`ExtruderState[]`) | **SUPPORTED** | `print.extruder.info[]` (`hnow`, `hpre`, `htar`) |
| `fan.cooling` | Part cooling fan speed control | **SUPPORTED** | `print.cooling_fan_speed` and `M106 P1 S{val}` |
| `fan.bigFan1` | Auxiliary fan speed control | **SUPPORTED** | `print.big_fan1_speed` and `M106 P2 S{val}` |
| `fan.bigFan2` | Chamber fan speed control | **SUPPORTED** | `print.big_fan2_speed` and `M106 P3 S{val}` |
| `ams` | Multi-AMS & Tray telemetry | **SUPPORTED** | `print.ams.ams[]` (trays, colors, remaining %) |
| `hms` | Diagnostic error codes | **SUPPORTED** | `print.hms[]` raw `{ attr, code }` entries |
