# MiniatureStudio — photo studio for tabletop miniatures

A web app (Flask + picamera2) for a Raspberry Pi with a camera, built for
photographing miniatures in a small light box or booth: live preview, every camera
control, photo/video, **focus stacking** with the bundled
[focus-stack](https://github.com/PetteriAimonen/focus-stack), camera presets, a
gallery, and (automatic) upload to Google Drive or a NAS.

## Install

On a Raspberry Pi running Raspberry Pi OS (Bookworm or newer), as your normal user:

```bash
curl -fsSL https://raw.githubusercontent.com/MichaelTimmermans/MiniatureStudio/main/install.sh | bash
```

Or from a clone:

```bash
git clone --recurse-submodules https://github.com/MichaelTimmermans/MiniatureStudio.git
cd MiniatureStudio && ./install.sh
```

The installer:

1. installs the system packages from [`apt-packages.txt`](apt-packages.txt)
   (picamera2, Flask, OpenCV, ffmpeg, rclone, cifs-utils, nfs-common, …);
2. clones the app to `/opt/miniaturestudio` (or uses your clone);
3. builds focus-stack from `vendor/focus-stack` (a git submodule) — roughly a
   quarter of an hour on a Pi 3B;
4. installs a small root helper for mounting a NAS (see below);
5. installs the `miniaturestudio` systemd service (starts at boot).

Then open `http://<hostname>.local:8000`.

## Updating

- In the web app: **Settings → Check for updates → Install update**. The app
  restarts by itself.
- Or in a terminal: `miniaturestudio-update` (`--check` to only look).

Updates follow the `main` branch via `git pull`. New system packages, a new
focus-stack version or a new mount helper are picked up automatically.

## Cameras and presets

Connected cameras are detected at startup (`Picamera2.global_camera_info()`).
In the **Camera** tab you pick the active camera and can mark one as the
default (opened at boot). CSI cameras are not hot-pluggable: connect them with
the Pi switched off. Check with `rpicam-hello --list-cameras`.

All libcamera controls of the camera appear in the UI automatically. Save them
as **presets** (per camera model); mark one preset as **Load at boot**. Without
a boot preset, the last used controls are restored.

### Arducam 16MP / 64MP and other third-party sensors

Official Raspberry Pi cameras are detected automatically. Arducam's 16MP
(IMX519) and 64MP (Hawkeye, OV64A40) autofocus cameras need a line in
`config.txt`: **Camera tab → Camera sensor setup → pick the sensor → Apply &
reboot**. The app sets `camera_auto_detect=0` plus the right `dtoverlay`
(with a CAM0/CAM1 port on a Pi 5 or Compute Module) and keeps a backup as
`config.txt.miniaturestudio.bak`; "Auto-detect" undoes it. 64MP frames are
~190 MB in memory: use a Pi 4/5, or choose a lower **Capture resolution**.

### USB webcams

UVC webcams work through the same app: pick them in the camera list (shown
as "(USB)"). MJPEG webcams are passed through without re-encoding — preview
and video (`.avi`, needs ffmpeg) cost the Pi almost nothing. YUYV-only
webcams do preview and photos but no video. USB cameras can be plugged in
while running: press **Rescan cameras**. Resolution: the webcam's largest
MJPEG size (override with `camera.usb_size` in `config.json`).

### Autofocus cameras (e.g. Camera Module 3)

When the camera supports `AfMode`/`LensPosition`:

- an **Autofocus** button (one AF cycle, then the lens is locked in manual);
- **Lens sweep**: set start/end LensPosition (dioptres: 0 = infinity, higher =
  closer), number of steps and settle time. The app takes all frames and stacks
  them automatically;
- stacks are always processed automatically (no Process button; only
  "Reprocess" if a run failed).

Manual-focus cameras such as the HQ Camera do not show the sweep; there you
stack manually (Start stack → Space per frame → Finish).

## Focus stacking

Frames of a stack go to `stacks/<name>/<name>_1.png`, `_2.png`, …; the result
is `<name>_stacked.png`. The stacking options (method, focus-stack's consistency, denoise, batch
size, alignment, depth map, …) are in **Settings** and can be overridden per
run in the **Stacks** tab.

- `batchsize = 0` merges all frames in one batch (best quality, lots of RAM: on
  a 1 GB Pi 3B keep it at 2-4).
- "Delete source frames after a successful stack" is on by default; if frames
  are uploaded as well, that happens first.
- Pi 3B tip: make sure there is swap (the System tab shows it) if focus-stack
  gets killed for lack of memory — see *Tips, tricks & gotchas* below.

## Speed

Only the capture itself happens while you wait (about a second); everything
else runs in the background:

1. **Live preview** uses the fast binned sensor mode and switches to full
   resolution just for the capture (Settings → Camera & performance → `fast`). The focus
   check switches to full resolution while it is on, and back 20 s after.
2. **Raw write**: the frame is written to disk as uncompressed TIFF right away.
3. **Compression** to PNG runs in low-priority workers, one per spare CPU core.
   Stack frames are never compressed if they are deleted after stacking —
   focus-stack reads the TIFFs directly.

The header shows what is still being written or compressed. Set the image
format to `tif` to skip compression entirely (files ~1.8× larger); TIFF files
then get a **Download PNG** button that compresses on download.

## Halo-free stacking (default)

Classic focus stackers (focus-stack's wavelet method) pick the frame with the
most detail per pixel. On a black backdrop the blurred rendition of a bright
edge in the defocused frames beats the featureless black of the in-focus
frame, so a glow ends up around the model. The default **halo-free** method
(`scripts/halofree-stack.py`, Python + OpenCV):

1. aligns all frames to the middle one (affine, covers focus breathing) and
   matches their brightness and colour;
2. takes the sharpest frame where one frame is clearly in focus;
3. in a band around the model takes the frame that is clearly darker there —
   next to a sharp edge that is pure black, so the glow disappears;
4. uses one fixed frame for the rest of the backdrop (no noise mosaic).

It works frame by frame (about 300 MB for 12 MP frames, so it fits a 1 GB
Pi 3B). Switch back with Settings → Stacking default options → Method →
`focus-stack`. Frames that show nothing sharp simply do not contribute: focus
from the front of the model to its back, not beyond.

## Exposure tips (and avoiding halos)

- **Histogram** and **Clipping** (next to the preview) are computed in the
  browser from the live view; clipped highlights are marked red.
- During a stack, exposure and white balance are **locked** automatically
  (Settings → Camera & performance), so all frames match — brightness or
  colour shifts between frames are a common cause of halos. **Lock exposure &
  WB** in the Camera tab does the same permanently.
- Set **Sharpness** to 0: in-camera sharpening draws bright rims around edges
  against a black background, and stacking makes them worse.
- Use **AnalogueGain 1.0** with a longer ExposureTime for a static model: less
  noise in the black background.

## Jobs

Long tasks run in the background so you can keep shooting: focus-stack
processing, uploads, lens sweeps and updates. The **Jobs** tab shows their
status and logs.

## File names

A pattern in Python `str.format` syntax, e.g. `{dt:%Y%m%d_%H%M%S}_{label}` or
`{seq:04d}_{label}`. `{seq}` increments every time it is used.

## Storage: SD card or USB disk

To spare the SD card, store photos on a USB disk: **Settings → Storage → Look
for USB disks → Use this disk**. Nothing is erased; a `MiniatureStudio` folder
is created on the disk (ext4, exFAT, FAT32 or NTFS). The disk is mounted again
at every boot and when you replug it. When switching you are offered to move
the existing photos along (a background job that deletes each file only after
it was copied); switching back to the SD card offers the same the other way.

If the selected disk is missing, capturing stops with a clear message instead
of silently writing to the SD card. Use **Safely remove USB disk** before
unplugging. A USB SSD is the fastest and most durable option.

## Upload

- **Google Drive**: **Settings → Connect Google Drive**. Sign in with Google in
  the tab that opens. Afterwards Google redirects to a `http://127.0.0.1:53682/…`
  address; when you are not browsing on the Pi itself that page fails to load —
  copy the full address and paste it into the app. The app then configures an
  rclone remote. Photos, videos and processed stacks are uploaded
  **automatically** (can be switched off).
- **NAS**: **Settings → NAS**: enter server, share and (for SMB) credentials, then
  **Mount NAS**. The share is added to `/etc/fstab` (with `nofail`, so a missing
  NAS never blocks booting) and mounted at every boot. Credentials are stored in
  `/etc/miniaturestudio/nas.cred`, readable by root only. The app refuses to copy
  when the share is not mounted, so the SD card never fills up.

## System tab and logs

Pi model, OS, CPU load/temperature/clock, memory, swap, disk space and app
version, plus warnings for **under-voltage / throttling** (from
`vcgencmd get_throttled`). The **Log** window shows the app's journal
(including libcamera's own messages); **Download debug log** puts system info,
settings, recent jobs, the app log and kernel messages in one text file —
the first thing to grab when something goes wrong. Restart app, reboot and
shut down are there too.

## Tips, tricks & gotchas

Things we ran into while building and testing this on a Pi 3B with the HQ
camera — worth reading before you start shooting.

### Good starting settings for miniatures

- **Manual exposure, gain 1.0.** A model does not move, so use a long
  exposure instead of gain: `ExposureTimeMode` = 1 (manual), `ExposureTime`
  e.g. 80000 µs (1/12 s), `AnalogueGainMode` = 1, `AnalogueGain` = 1.0. Gain 16
  at 1/200 s gives the same brightness with far more noise (speckles in the
  black backdrop).
- **Newer Raspberry Pi OS (Trixie, libcamera 0.5+)** sets auto/manual per value
  with `ExposureTimeMode` / `AnalogueGainMode`; older versions use `AeEnable`.
  Moving the ExposureTime / AnalogueGain / ColourGains slider switches that
  value to manual automatically; turning auto back on drops the old manual
  value (stale values used to make photos 4 stops darker than the preview).
- **Sharpness 0.** In-camera sharpening draws bright rims on a black backdrop.
- **AeFlickerMode Off**, or Manual with `AeFlickerPeriod` **10000** (50 Hz mains)
  or 8333 (60 Hz). Other values only restrict auto exposure.
- **Metering Spot or CentreWeighted** for a centred model on black; Matrix
  over-exposes because of all the black.
- **Watch the histogram:** keep *Blown highlights* near 0 %. Clipped whites and
  metallics make stacking halos much worse.
- Happy? **Save as…** a preset and mark it **Load at boot**. Re-save presets
  after changing modes, so they do not carry old values.
- Every setting has an **ⓘ** with an explanation.

### Preview vs. photo

- The **fast** preview uses the binned half-resolution sensor mode; the photo
  uses full resolution. On the IMX477 the binned mode is about **2.3× (1.2
  stops) more sensitive**. With auto exposure the camera compensates with gain
  (the photo waits until exposure settles); with fully manual settings the
  photo is darker than the fast preview.
- **Live preview → `full`** makes preview and photo use the very same mode:
  exactly what you see, near-instant captures, but a slower preview (~10 fps).
- Each fast-mode capture reserves ~55 MB of camera memory; on a 1 GB Pi 3B this
  can take several seconds right after background compression. `full` avoids it.
- **Focus check** keeps the camera in full resolution (slower preview) — switch
  it off when not focusing. Long exposures slow any preview (1/5 s = 5 fps).
- The capture log line (System → Log, filter `capture`) shows preview vs photo
  exposure and gain — the quickest way to see why a photo differs.

### Focus stacking

- **Halos on a black backdrop** come from the stacker picking the blur of bright
  edges in defocused frames. Use the **halo-free** method (default).
- **Focus from the front of the model to its back, not beyond.** Frames that
  only show the velvet in front or the backdrop behind contribute nothing.
- **More frames, smaller steps** = narrower halos and more even sharpness.
- **Keep all frames identical in exposure and colour** — the automatic exposure
  lock during a stack does this; one auto-exposed frame at half brightness was
  enough to cause visible edges.
- A thin blue/purple edge on bright contours is **lens colour fringing** — it is
  already in the single frames, not a stacking artefact.
- To debug a stack, untick **Delete source frames after a successful stack** so
  you can download the zip with all frames.
- Shoot everything first, then **Process all unprocessed stacks** and walk away:
  stacks are processed one after another in the background.

### Raspberry Pi 3B specifics

- **Memory:** focus-stack with all cores ran out of memory (`exit code -9`, the
  kernel's OOM killer). Threads "auto" now uses 1 thread on 1 GB, compressors
  pause while stacking, and an OOM run is retried leaner. Halo-free stacking
  needs only ~300 MB.
- **Swap:** check it in the System tab. Bookworm: set `CONF_SWAPSIZE=2048` in
  `/etc/dphys-swapfile`, then `sudo systemctl restart dphys-swapfile`. Trixie
  configures swap differently (zram + swapfile via `rpi-swap`).
- **PNG encoding of 12 MP takes 10-15 s** on a Pi 3B — that is why frames are
  written as raw TIFF first and compressed in the background.
- **USB 2.0 only** (~35 MB/s, shared): a USB SSD beats a cheap stick.
- A Pi 4/5 with 4 GB makes stacking several times faster and allows batch
  size 0 and full-resolution alignment. The Pi 5 needs a different camera
  cable (22-pin) and a 5 A supply.

### Power and hardware

- **Under-voltage** (System tab / header warning) is measured by the Pi itself at
  ~4.63 V. Power HATs with a buck regulator need **more** input voltage than
  5 V (often 6-12 V); feeding one 5 V gave under-voltage and throttling. With a
  proper 12 V supply the warning disappeared.
- **"Camera frontend has timed out"** in the log = the camera is detected but no
  image arrives: a loose, reversed or pinched **ribbon cable**. Reseat both ends
  with the Pi switched off. The header warns when the preview gets no frames.
- Always **shut down** from the System tab before unplugging — pulling the
  power can corrupt the SD card.

### Updates, browser and network

- **Do not edit files on the Pi** — updates use `git pull --ff-only`; change
  things on your PC, push, and press Install update.
- While the GitHub repo is private the Pi needs stored credentials
  (`git config --global credential.helper store` before cloning).
- **Chrome allows 6 connections per address.** Every open tab holds one for the
  live preview; with many tabs (or a stuck preview) the rest of the app seems
  slow. Keep one tab open.
- **Security extensions** (e.g. Malwarebytes Browser Guard) may flag the page as
  a "browser locker" — a false positive; allow-list the Pi's address.
- Opening the page while the app restarts can briefly show "focus-stack
  missing"; the page now retries by itself.

### Handy commands

```bash
rpicam-hello --list-cameras                         # is the camera detected?
journalctl -u miniaturestudio -b --no-pager | grep -v werkzeug | tail -60
miniaturestudio-update                              # update from a terminal
systemd-analyze blame | head -15                    # what slows booting down
```

## Developing without a Pi

```bash
pip install -r requirements.txt
python app.py --demo --port 8000
```

Demo mode simulates a camera (with AF, so the sweep can be tested).

## Hardware this was built for

Raspberry Pi 3B, HQ Camera (IMX477), 5-50 mm CS-mount varifocal with macro ring
(manual focus), 30×30×40 cm booth. Shoot at F8: smaller apertures cause
diffraction on this sensor; focus stacking gives more depth of field instead.

## License

MIT — see [LICENSE](LICENSE).
The bundled focus-stack is © Petteri Aimonen, also MIT (see `vendor/focus-stack/LICENSE.md`).

## Built with Claude

This project was developed with the help of [Claude Code](https://claude.com/claude-code),
Anthropic's AI coding assistant.
