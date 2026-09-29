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
is `<name>_stacked.png`. focus-stack's options (consistency, denoise, batch
size, alignment, depth map, …) are in **Settings** and can be overridden per
run in the **Stacks** tab.

- `batchsize = 0` merges all frames in one batch (best quality, lots of RAM: on
  a 1 GB Pi 3B keep it at 4).
- "Delete source frames after a successful stack" is on by default; if frames
  are uploaded as well, that happens first.
- Pi 3B tip: enlarge swap (`sudo nano /etc/dphys-swapfile`,
  `CONF_SWAPSIZE=2048`) if focus-stack gets killed for lack of memory.

## Speed

Only the capture itself happens while you wait (about a second); everything
else runs in the background:

1. **Live preview** uses the fast binned sensor mode and switches to full
   resolution just for the capture (Settings → Performance → `fast`). The focus
   check switches to full resolution while it is on, and back 20 s after.
2. **Raw write**: the frame is written to disk as uncompressed TIFF right away.
3. **Compression** to PNG runs in low-priority workers, one per spare CPU core.
   Stack frames are never compressed if they are deleted after stacking —
   focus-stack reads the TIFFs directly.

The header shows what is still being written or compressed. Set the image
format to `tif` to skip compression entirely (files ~1.8× larger); TIFF files
then get a **Download PNG** button that compresses on download.

## Exposure tips (and avoiding halos)

- **Histogram** and **Show clipping** (below the preview) are computed in the
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
