# MiniatureStudio — photo studio for tabletop miniatures

A web app for a Raspberry Pi with a camera in a small fixed booth: put a model
in, open the page on your phone or PC, and shoot. Lighting, camera settings and
framing stay the same, so every model gets a consistent photo without setting
everything up again. Focus stacking merges several shots into one sharp image
in the background.

## Examples

Shot with a Raspberry Pi 3B and the HQ Camera (5-50 mm varifocal, manual
focus) in a black booth. Both are 8-frame stacks with the **halo-free**
method: manual exposure 97 ms (~1/10 s), gain 1.0, white balance locked, so
all frames are identical. Processing on the Pi 3B took 132 s and 176 s.

![Chaos Chariot painted by Michael Timmermans, 8-frame halo-free stack](docs/examples/chaos-chariot-stacked.jpg)

*Chaos Chariot, painted by Michael Timmermans.*

![Skaven Verminlord painted by Michael Timmermans, 8-frame halo-free stack](docs/examples/verminlord-stacked.jpg)

*Skaven Verminlord, painted by Michael Timmermans.*

Each source frame of the Verminlord is sharp at one depth only; the stack combines them:

![Verminlord source frames 2, 5 and 8 next to the stacked result](docs/examples/verminlord-frames.jpg)

At 100 % — a single frame (focused on the base) next to the stacked result:

![Verminlord head at 100%: single frame versus stacked](docs/examples/verminlord-detail.jpg)

## Screenshots

The whole studio in one browser window — live preview with crop frame, clipping
warning and focus check on the left, histogram in the middle, capture controls
on the right. Works on a phone too.

![Main view: live preview with crop frame, clipping and focus check, histogram and capture controls](docs/screenshots/main.jpg)

<table>
<tr><td align="center" valign="top"><a href="docs/screenshots/camera.jpg"><img src="docs/screenshots/thumbs/camera.jpg" width="260" alt="Camera — most-used controls on top, ⓘ on every setting"></a><br><sub>Camera — most-used controls on top, ⓘ on every setting</sub></td><td align="center" valign="top"><a href="docs/screenshots/stacks.jpg"><img src="docs/screenshots/thumbs/stacks.jpg" width="260" alt="Stacks — queue, reprocess, download, upload"></a><br><sub>Stacks — queue, reprocess, download, upload</sub></td><td align="center" valign="top"><a href="docs/screenshots/gallery.jpg"><img src="docs/screenshots/thumbs/gallery.jpg" width="260" alt="Gallery — view, download, multi-select delete"></a><br><sub>Gallery — view, download, multi-select delete</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/screenshots/jobs.jpg"><img src="docs/screenshots/thumbs/jobs.jpg" width="260" alt="Jobs — stacking and uploads in the background"></a><br><sub>Jobs — stacking and uploads in the background</sub></td><td align="center" valign="top"><a href="docs/screenshots/system.jpg"><img src="docs/screenshots/thumbs/system.jpg" width="260" alt="System — Pi stats, logs, reboot / shut down"></a><br><sub>System — Pi stats, logs, reboot / shut down</sub></td><td align="center" valign="top"><a href="docs/screenshots/settings.jpg"><img src="docs/screenshots/thumbs/settings.jpg" width="260" alt="Settings — updates, USB disk, Google Drive, NAS"></a><br><sub>Settings — updates, USB disk, Google Drive, NAS</sub></td></tr>
</table>

## The booth

A closed box keeps the light and background identical for every model: the
camera looks in through the front, the Pi sits on the back, and the walls are
painted with Black 3.0. The 3D-printable parts are on Thingiverse:
**[thing:7416432](https://www.thingiverse.com/thing:7416432)**.

<table>
<tr><td align="center" valign="top"><a href="docs/booth/booth-closed.jpg"><img src="docs/booth/thumbs/booth-closed.jpg" width="260" alt="The booth, closed"></a><br><sub>The booth, closed</sub></td><td align="center" valign="top"><a href="docs/booth/booth-open.jpg"><img src="docs/booth/thumbs/booth-open.jpg" width="260" alt="Open front, Pi at the back"></a><br><sub>Open front, Pi at the back</sub></td><td align="center" valign="top"><a href="docs/booth/booth-inside.jpg"><img src="docs/booth/thumbs/booth-inside.jpg" width="260" alt="Lit interior, Black 3.0 walls"></a><br><sub>Lit interior, Black 3.0 walls</sub></td></tr>
<tr><td align="center" valign="top"><a href="docs/booth/camera-mount.jpg"><img src="docs/booth/thumbs/camera-mount.jpg" width="260" alt="HQ camera looking in"></a><br><sub>HQ camera looking in</sub></td><td align="center" valign="top"><a href="docs/booth/electronics.jpg"><img src="docs/booth/thumbs/electronics.jpg" width="260" alt="Pi 3B, power HAT and USB disk"></a><br><sub>Pi 3B, power HAT and USB disk</sub></td><td align="center" valign="top"><a href="docs/booth/tilt-bracket.jpg"><img src="docs/booth/thumbs/tilt-bracket.jpg" width="260" alt="Tilt bracket with locking knob"></a><br><sub>Tilt bracket with locking knob</sub></td></tr>
</table>

## Features

- Live preview with grid, histogram, clipping warning and a 100 % focus check
- Every camera control in the browser, with presets that load at boot
- Photos and **focus stacking** — manual, or an automatic lens sweep on
  autofocus cameras — with a halo-free method made for black backdrops
- Exposure check before shooting: judged on the model, with a suggested exposure
- Crop to a tall or wide frame before shooting
- Fast captures: saving, compressing, stacking and uploading run in the
  background — by default stacking waits until you pause shooting
- Storage on the SD card or a USB disk; upload to Google Drive or a NAS
- Gallery with multi-select, System tab with Pi stats, logs, reboot/shutdown
- Update banner and one-click updates from the web app; runs on a Raspberry Pi 3B

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
   (picamera2, Flask, OpenCV, rclone, cifs-utils, nfs-common, …);
2. clones the app to `/opt/miniaturestudio` (or uses your clone);
3. builds [focus-stack](https://github.com/PetteriAimonen/focus-stack) from
   `vendor/focus-stack` (a git submodule) — roughly a quarter of an hour on a
   Pi 3B;
4. installs a small root helper for mounting a USB disk or NAS;
5. installs the `miniaturestudio` systemd service (starts at boot).

Then open `http://<hostname>.local:8000`.

## Updating

- In the web app: the app checks for updates when it starts (and every 6 hours)
  and shows a banner at the top of the page — **Show & install**. Or any time:
  **Settings → Check for updates → Install update**. The app restarts by itself.
- Or in a terminal: `miniaturestudio-update` (`--check` to only look).

Updates follow the `main` branch via `git pull`. New system packages, a new
focus-stack version or a new mount helper are picked up automatically.
Opening the page while the app restarts can briefly show "focus-stack
missing"; the page retries by itself.

## Documentation

- [Hardware](docs/hardware.md) — tested setup, lens and aperture, the
  3D-printable booth, supported cameras, Raspberry Pi 3B notes
- [Camera settings](docs/camera-settings.md) — starting settings for miniatures,
  presets, preview vs. photo
- [Focus stacking](docs/focus-stacking.md) — manual stacks, lens sweep, the
  halo-free method, tips
- [Cropping](docs/cropping.md) — tall or wide models
- [Storage and upload](docs/storage-and-upload.md) — file names, gallery, USB
  disk, Google Drive, NAS
- [Speed](docs/speed.md) — what runs in the background
- [Troubleshooting](docs/troubleshooting.md) — System tab, logs, common problems

## Tested hardware

Raspberry Pi 4 (1 GB) and Raspberry Pi 3B, Raspberry Pi HQ Camera (IMX477) with a 5-50 mm C-mount
varifocal lens, in a black booth — the 3D-printable parts are on Thingiverse:
[thing:7416432](https://www.thingiverse.com/thing:7416432). The Arducam 16 MP
(IMX519) autofocus camera, with autofocus and lens sweep, and a USB webcam
(Sony IMX179) work too. Details and other cameras: [Hardware](docs/hardware.md).

## Hardware: Raspberry Pi and storage

12 MP focus stacking is heavy work, and **the disk matters as much as the Pi**.
A stack writes one ~37 MB frame after another and the stacker reads every frame
several times, so a slow disk makes even a fast Pi feel sluggish — and a good disk
makes the whole app noticeably smoother.

### Raspberry Pi

| Pi | Status | Stacking (halo-free), per frame | PNG compression, per 12 MP image | Notes |
|---|---|---|---|---|
| Pi 3B, 1 GB | **tested** | 16-22 s *(8 frames in 132-176 s)* | 10-15 s | Works. USB 2 only (~35 MB/s for the disk); slows down noticeably while it processes. |
| Pi 4, 1 GB | **tested** | ~4 s *(21 frames in 78 s, with the hard disk below)* | 3.5-6 s | Clearly smoother. USB 3; 1 GB still means one job at a time. |
| Pi 4, 4 GB | not tested — better | ~4 s *(expected)* | same, 3 at a time *(expected)* | More memory: no swapping, compression and the app keep going while it stacks. |
| Pi 5, 4 GB | not tested — best | ~2 s *(expected)* | faster *(expected)* | Fastest; can use an NVMe SSD. Needs a different camera cable, a 27 W power supply and active cooling. |

8 GB is not needed. The app scales its stacking threads and compression workers
with the memory it finds. Moving the SD card from a Pi 3B to a Pi 4 just works.

### Storage

What counts is the **sustained** write speed: the speed printed on a USB stick is
usually only its small fast buffer, which is full after a few frames. Measure a
disk with **Settings → Storage → Speed test**. Tested so far:

| Disk | File system | Pi | Sustained write | Per frame in a stack | Verdict |
|---|---|---|---|---|---|
| Cheap 4 GB USB stick | FAT32 | Pi 3B (USB 2) | — | slowed down after ~4 frames *(observed)* | too slow |
| Kingston DataTraveler 64 GB USB 3 stick ("60 MB/s" on the box) | ext4 | Pi 4 | ~3 MB/s | 20-30 s | too slow |
| the same stick | exFAT | Pi 4 | ~7 MB/s (jumping 3-17) | ~6 s *(from the speed test)* | too slow for stacks |
| NVMe SSD in a USB enclosure (at USB 2 because of the cable) | NTFS | Pi 4 | — | 0.7-0.8 s; stacking ~7 s per frame | good |
| **Old 2.5" laptop hard disk in a USB 3 enclosure** | **ext4** | Pi 4 | **~50 MB/s (75-88 steady)** | **0.1 s; stacking ~4 s per frame** | **best so far** |

For comparison, the Kingston stick on a Windows laptop: 18 MB/s write (H2testw).

- **Use a hard disk or an SSD, formatted as ext4.** An old laptop disk you were
  about to throw away works great; a small one is plenty.
- **USB sticks are finicky**: fine for occasional photos, too slow for stacks. If
  you use one, format it as **exFAT** — ext4's journal makes cheap sticks much slower.
- **Avoid NTFS** on a Pi: it works, but goes through a slow driver.

More (formatting, power and vibration of hard disks):
[Which disk?](docs/storage-and-upload.md#which-disk) ·
[Hardware](docs/hardware.md#raspberry-pi-3b-notes).

## License

MIT — see [LICENSE](LICENSE).
The bundled focus-stack is © Petteri Aimonen, also MIT (see `vendor/focus-stack/LICENSE.md`).

## Built with Claude

This project was developed with the help of [Claude Code](https://claude.com/claude-code),
Anthropic's AI coding assistant.
