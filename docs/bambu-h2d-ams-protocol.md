# Bambu Lab H2D AMS Protocol Audit & Verification Report

## Overview
This document details the reverse-engineered and verified MQTT & G-code protocol specifications for controlling the Automatic Material System (AMS) on Bambu Lab printers, specifically tailored for the **Bambu Lab H2D (Dual-Nozzle / Multi-Hotend)** architecture.

---

## 1. Connection & MQTT Topics
* **Connection Type**: TLS/SSL MQTT (Port 8883) with Client Certificates / Access Code. [`CONFIRMED`]
* **Request Topic (Commands)**: `device/{SERIAL}/request` [`CONFIRMED`]
* **Report Topic (Telemetry)**: `device/{SERIAL}/report` [`CONFIRMED`]

---

## 2. AMS Command Payload Specifications

### 2.1 Load Filament (`ams_change_filament`)
* **Purpose**: Instructs printer to perform a manual or automated filament load from an AMS slot.
* **Payload Structure**:
  ```json
  {
    "print": {
      "sequence_id": "2001",
      "command": "ams_change_filament",
      "target": 0,
      "curr_temp": 220,
      "tar_temp": 220
    }
  }
  ```
* **Parameters**:
  * `target`: AMS Slot Index (`0..3` for unit 0, `4..7` for unit 1). [`CONFIRMED`]
  * `curr_temp`: Current active nozzle temperature setting (°C). [`CONFIRMED`]
  * `tar_temp`: Target nozzle temperature setting (°C). [`CONFIRMED`]
* **Protocol Confidence**: `CONFIRMED` (Verified via OpenBambuAPI & Bambu MCP).

### 2.2 Unload Filament (`ams_change_filament` with target `255`)
* **Purpose**: Instructs printer to retract filament from active toolhead back into AMS unit.
* **Payload Structure**:
  ```json
  {
    "print": {
      "sequence_id": "2005",
      "command": "ams_change_filament",
      "target": 255,
      "curr_temp": 220,
      "tar_temp": 220
    }
  }
  ```
* **Sentinel Values Distinction**:
  * **MQTT API Level**: Target `255` (`0xFF`) represents Unload Sentinel across all Bambu MQTT APIs. [`CONFIRMED`]
  * **G-code Level**: Values `65535` (`0xFFFF`) and `65279` (`0xFEFF`) are uint16 sentinels used inside sliced G-code macro blocks (`M620 S65535` / `M621 S65279`) to bypass filament cut during end G-code. [`CONFIRMED`]
* **Protocol Confidence**: `CONFIRMED`.

### 2.3 AMS Filament Setting (`ams_filament_setting`)
* **Purpose**: Configures tray material profile, RGBA hex color, and temperature ranges.
* **Payload Structure**:
  ```json
  {
    "print": {
      "sequence_id": "2007",
      "command": "ams_filament_setting",
      "ams_id": 0,
      "tray_id": 0,
      "tray_info_idx": "PETG",
      "tray_type": "PETG",
      "tray_color": "DBC8B6FF",
      "nozzle_temp_min": 190,
      "nozzle_temp_max": 240
    }
  }
  ```
* **Parameters**:
  * `tray_color`: 8-character uppercase RGBA Hex string (e.g. `DBC8B6FF` with `FF` alpha byte). [`CONFIRMED`]
  * `tray_info_idx`: Material profile index / identifier string. [`CONFIRMED`]
  * `tray_type`: Material type string (PLA, PETG, ABS, TPU...). [`CONFIRMED`]
* **Protocol Confidence**: `CONFIRMED`.

### 2.4 AMS RFID Read Request (`ams_get_rfid`)
* **Purpose**: Requests printer to read RFID chip data for specified AMS slot.
* **Payload Structure**:
  ```json
  {
    "print": {
      "sequence_id": "2010",
      "command": "ams_get_rfid",
      "ams_id": 0,
      "slot_id": 0
    }
  }
  ```
* **Protocol Confidence**: `CONFIRMED` (Source: OpenBambuAPI).

### 2.5 AMS Control Retry (`ams_control`)
* **Purpose**: Instructs printer to retry AMS filament feeding or retraction after a tangle or feed failure.
* **Payload Structure**:
  ```json
  {
    "print": {
      "sequence_id": "2006",
      "command": "ams_control",
      "param": "retry"
    }
  }
  ```
* **Protocol Confidence**: `PROTOCOL_UNVERIFIED` (Observed in community implementations, requires empirical H2D verification).

---

## 3. Bambu H2D Architecture & Dual-Nozzle Semantics

### 3.1 Dual-Hotend Hardware Mapping
The H2D model features **2 Nozzles (Nozzle 0 & Nozzle 1)** and **2 Extruders (Extruder 0 & Extruder 1)**:
* `print.nozzle.src_id`: Indicates the currently active activeNozzleId (`0` or `1`). [`CONFIRMED`]
* `print.extruder.info[0]` & `info[1]`: Report individual hardware temperatures for Extruder/Nozzle 0 & 1. [`CONFIRMED`]

### 3.2 G-Code vs MQTT API Workflow Distinction
* **Manual Control (Web UI / Mobile App)**: Uses MQTT Commands (`ams_change_filament` target `0..3` / `255`).
* **Slicing Print Job Workflow**: Slicer injects G-code commands `M620` (start tool change), `T0`/`T1` (tool selection), `M621` (finish tool change), `M1020` (AMS state sync). Gateway does NOT mix G-code macro commands with direct MQTT control APIs. [`CONFIRMED`]

---

## 4. Multi-Field Telemetry Verification Matrix

Command verification uses `AmsCommandVerifier` evaluating multiple telemetry fields:
1. `print.ams.tray_now`: Trays `0..3` vs Sentinel `255`.
2. `print.ams.tray_tar`: Target tray during transition.
3. `print.nozzle.src_id`: Active nozzle ID.
4. `print.hms`: HMS error codes (e.g., filament tangle `0300_8000`, feed fail).
5. `print.gcode_state` / `stg_cur`: Machine operating stage (`RUNNING`, `PAUSED`, `IDLE`).

---

## 5. Summary Matrix of Protocol Evidence

| Feature / Command | Topic | Protocol Status | Source / Evidence |
| :--- | :--- | :--- | :--- |
| `ams_change_filament` (Load) | `device/{SERIAL}/request` | `CONFIRMED` | OpenBambuAPI, Bambu MCP |
| `ams_change_filament` (Unload 255) | `device/{SERIAL}/request` | `CONFIRMED` | OpenBambuAPI, Bambu MQTT Spec |
| `ams_filament_setting` | `device/{SERIAL}/request` | `CONFIRMED` | OpenBambuAPI, Bambu MCP |
| `ams_get_rfid` | `device/{SERIAL}/request` | `CONFIRMED` | OpenBambuAPI |
| `ams_control` (Retry) | `device/{SERIAL}/request` | `PROTOCOL_UNVERIFIED` | Community reverse-engineering |
| Active Nozzle (`src_id`) | `device/{SERIAL}/report` | `CONFIRMED` | H2D Raw MQTT Telemetry |
