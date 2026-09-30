# Camera settings

[← Documentation](README.md)

All libcamera controls of the camera appear in the **Camera** tab
automatically. The ones you use most sit on top under **Most used**; add or
remove controls there with ★ / ☆. Every setting has an **ⓘ** with an
explanation. On phones, − and + buttons next to each slider allow fine steps.

## Good starting settings for miniatures

- **Manual exposure, gain 1.0.** A model does not move, so use a long
  exposure instead of gain: `ExposureTimeMode` = 1 (manual), `ExposureTime`
  e.g. 80000 µs (1/12 s), `AnalogueGainMode` = 1, `AnalogueGain` = 1.0. Gain 16
  at 1/200 s gives the same brightness with far more noise (speckles in the
  black backdrop).
- **Newer Raspberry Pi OS (Trixie, libcamera 0.5+)** sets auto/manual per value
  with `ExposureTimeMode` / `AnalogueGainMode`; older versions use `AeEnable`.
  Moving the ExposureTime / AnalogueGain / ColourGains slider switches that
  value to manual automatically; turning auto back on drops the old manual
  value.
- **Sharpness 0.** In-camera sharpening draws bright rims around edges on a
  black backdrop, and stacking makes them worse.
- **AeFlickerMode Off**, or Manual with `AeFlickerPeriod` **10000** (50 Hz mains)
  or 8333 (60 Hz). Other values only restrict auto exposure.
- **Metering Spot or CentreWeighted** for a centred model on black; Matrix
  over-exposes because of all the black.
- **Watch the histogram** (next to the preview; **Clipping** marks blown areas
  red): keep *Blown highlights* near 0 %. Clipped whites and metallics make
  stacking halos much worse.
- **Lock exposure & WB** keeps the current automatic values as fixed manual
  settings — a quick way to get a consistent look. During a stack this happens
  automatically (Settings → Camera & performance).

## Presets

Save the current settings as a **preset** (per camera model) and mark one as
**Load at boot** — every model then gets the same look without setting anything
up again. Without a boot preset, the last used controls are restored at boot.
Re-save presets after switching between auto and manual, so they do not carry
old values.

## Preview vs. photo

- The **fast** live preview uses the binned half-resolution sensor mode; the
  photo uses full resolution. On the IMX477 the binned mode is about **2.3×
  (1.2 stops) more sensitive**. With auto exposure the camera compensates with
  gain (the photo waits until exposure settles); with fully manual settings the
  photo is darker than the fast preview.
- **Settings → Camera & performance → Live preview → `full`** makes preview and
  photo use the very same mode: exactly what you see, near-instant captures,
  but a slower preview (~10 fps).
- Each fast-mode capture reserves ~55 MB of camera memory; on a 1 GB Pi 3B this
  can take several seconds right after background compression. `full` avoids it.
- **Focus check** keeps the camera in full resolution (slower preview) — switch
  it off when not focusing. Long exposures slow any preview (1/5 s = 5 fps).
- The capture log line (System → Log, filter `capture`) shows preview vs photo
  exposure and gain — the quickest way to see why a photo differs.
