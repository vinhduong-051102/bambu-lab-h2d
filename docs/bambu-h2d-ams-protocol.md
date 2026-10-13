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
      "target": 6,
      "ams_id": 1,
      "slot_id": 2,
      "curr_temp": 215,
      "tar_temp": 245
    }
  }
  ```
* **Parameters**:
  * `target`: absolute tray index, `ams_id * 4 + slot_id` (AMS HT: `ams_id`, 128+). [`CONFIRMED`]
  * `ams_id` / `slot_id`: unit and slot, read by H2-series (multi-extruder) firmware as sent by Bambu Studio. [`POSSIBLE` – pending a printer reply capture]
  * `curr_temp`: temperature for purging the filament being replaced (°C). The gateway uses the midpoint of the loaded tray's `nozzle_temp_min/max`. [`CONFIRMED`]
  * `tar_temp`: temperature for the new filament; the gateway uses the midpoint of the target tray's range. [`CONFIRMED`]
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
      "ams_id": 255,
      "slot_id": 255,
      "curr_temp": 215,
      "tar_temp": 215
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
      "slot_id": 0,
      "tray_info_idx": "GFG99",
      "tray_type": "PETG",
      "tray_color": "DBC8B6FF",
      "nozzle_temp_min": 190,
      "nozzle_temp_max": 240
    }
  }
  ```
* **Parameters**:
  * `tray_color`: 8-character uppercase RGBA Hex string (e.g. `DBC8B6FF` with `FF` alpha byte). [`CONFIRMED`]
  * `tray_info_idx`: filament profile id such as `GFG99` (Generic PETG) or `GFA18` – not the material name. The gateway defaults to the Bambu generic profile of `tray_type`. [`CONFIRMED`]
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

## 4. Loaded-Tray Telemetry & Command Verification

* **H2D does not use `print.ams.tray_now`** – it stays `"255"` (also `tray_tar`, `tray_pre`). [`CONFIRMED` on live H2D telemetry]
* The loaded slot is reported per extruder in `print.device.extruder.info[i]`: `snow` (now), `spre` (previous), `star` (target), each `(ams_id << 8) | slot_id`. `0xFFFF` = nothing loaded; `ams_id` 254 = external spool. Extruder 0 = right nozzle, 1 = left. [`CONFIRMED`]
* Tray `state: 11` only means a spool is present in the slot, not that it is fed into a toolhead.

`AmsCommandTracker` resolves each command from:
1. **Printer reply** on the report topic with the same `command` and `sequence_id`: `result: "success"` → `VERIFYING`; anything else → `FAILED` with `reason`.
2. **Telemetry**: load completes when the target tray is in an extruder's `snow` **and** `print.ams_status` is back to idle (main byte `(ams_status >> 8) & 0xFF` = 0); unload when no AMS tray is loaded and the AMS is idle. On H2D `snow`/`star` switch to the target as soon as the load starts while `ams_status` = `0x0102` (filament change), so `snow` alone is not proof of completion. [`CONFIRMED` on live H2D, 2026-10-13]
3. **HMS**: a new error from an AMS module (`attr` top byte `0x07` AMS, `0x12` AMS lite, `0x18` AMS HT) that was not active when the command was sent → `FAILED`.
4. **Timeout**: 180 s for load/unload (heat, cut, feed, purge), 30 s for setting / RFID / retry.

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
