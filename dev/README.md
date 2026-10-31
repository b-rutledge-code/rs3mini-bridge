# Development utilities

Optional tools for bring-up, calibration, and vision+wire bench. Not required for production **`rs3mini-bridge`** service.

Run from repo root. **`BRIDGE_URL`** when the bridge is not on localhost (e.g. `http://<bridge-host>:8787`).

## BLE scan

| Script | npm | Purpose |
|--------|-----|---------|
| `scan.mjs` | `npm run scan` | List BLE devices; find unit suffix for **`GIMBAL_NAME_RE`** |

## Calibration (wire only)

Logs **`calibration-poses.jsonl`**. Policy: [projects/GIMBAL-BLE.md](../../projects/GIMBAL-BLE.md) **Pan/tilt calibration**.

| npm script | Purpose |
|------------|---------|
| `calib:from-bridge` | Snapshot pose via running bridge |
| `calib:phase-a` | CTR + four d-pad nudges |
| `calib:closed-loop` | Nudge toward **`TARGET_TILT`/`TARGET_PAN`** |
| `calib:analyze` | Summarize JSONL |

Full list: [API.md](../API.md) **Bench calibration**.

## Vision bench (Larix + wire)

Correlates **`0x04/0x66` @2/@8** with what the phone camera sees (RTSP → JPEG → SSIM). Requires **`rs3mini-bridge/.local/vision.env`**:

```bash
source .local/vision.env   # RTSP_URL, BRIDGE_URL, LARIX_URL
npm run vision:grab        # one frame → vision-current.jpg
```

| npm script | Purpose |
|------------|---------|
| `vision:grab` | Single JPEG from **`RTSP_URL`** |
| `vision:observe` | One cycle: baseline + four probes, log wire + frames |
| `vision:learn` | **Incremental learn loop** — replays **`vision-learn.jsonl`**, adds cycles, writes **`vision-understanding.json`** each cycle |
| `vision:learn:tilt+` | Focus **tilt+** only, 6 s hold, exit when **@2** sign confident |
| `vision:learn:pan+` | Focus **pan+** only (pan @8 may stay split — see GIMBAL-BLE) |
| `vision:demo` | Visible 4 s hold per axis for operator watch |
| `vision:ralph` | Legacy gate loop (600 ms probes) |

**Learn loop behavior:** Each probe row votes on **non-zero wire deltas** only; **moved** = wire step **or** SSIM below **`LEARN_VISUAL_SSIM`** (default 0.98). **`LEARN_FOCUS`**, **`LEARN_EXIT_PROBE`**, **`LEARN_HOLD_MS`** override via env. Outputs:

| File | Role |
|------|------|
| `vision-learn.jsonl` | Append-only probe log (replay source) |
| `vision-understanding.json` | Accumulated claims + confidence |
| `vision-learn-report.json` | Latest cycle snapshot |
| `vision-learn/` | JPEG frames per cycle |

**Ghost BLE:** HTTP **`OK`** but no motion — gimbal power cycle + Pi reboot. See [GIMBAL-BLE.md](../../projects/GIMBAL-BLE.md) **Ghost BLE**.
