# Storage and upload

[← Documentation](README.md)

## File names

A pattern in Python `str.format` syntax (Settings → Files), e.g.
`{dt:%Y%m%d_%H%M%S}_{label}` or `{seq:04d}_{label}`. `{label}` is what you type
on the Capture tab; `{seq}` increments every time it is used.

## File formats

Every photo, stack frame and stack result is saved as an **uncompressed TIFF**
first — the fastest lossless option on a Pi. **Settings → Files → Compression**
then optionally makes a smaller copy in the background:

| Compression | Keep the TIFF | Files per image |
|---|---|---|
| None | — | the TIFF |
| PNG (lossless, ~half the size) or JPG (small, lossy) | off (default) | the compressed copy |
| PNG or JPG | on | the TIFF **and** the compressed copy |

The gallery and the Stacks tab show one entry per image; a kept TIFF gets its
own **Download TIFF** button. Stacking always uses the TIFF frames.

## Gallery

The **Gallery** and **Stacks** tabs show everything you shot, with view,
download and delete. Tick several items (shift-click for a range, or **Select
all**) and **Delete selected** to clean up quickly. Stacks download as a zip.

## SD card or USB disk

To spare the SD card, store photos on a USB disk: **Settings → Storage → Look
for USB disks → Use this disk**. Nothing is erased; a `MiniatureStudio` folder
is created on the disk (ext4, exFAT, FAT32 or NTFS). The disk is mounted again
at every boot and when you replug it. When switching you are offered to move
the existing photos along (a background job that deletes each file only after
it was copied); switching back to the SD card offers the same the other way.

**Formatting:** next to each disk, **Format as ext4…** and **Format as exFAT…**
erase it (type FORMAT to confirm). ext4 is best for SSDs. Cheap USB sticks can be
much slower with ext4 (its journal makes many small writes elsewhere on the
stick) — try exFAT and compare with the **Speed test** (Settings → Storage).

**Use ext4 for speed.** On a Pi, NTFS goes through a slow userspace driver that
costs a lot of CPU on every write; exFAT/FAT32 are better, ext4 is fastest and
survives power cuts best. **Format as ext4…** next to a disk erases it and sets it
up (type FORMAT to confirm). Windows cannot read ext4 without extra software — fine
for a disk that stays on the Pi. The disk in use cannot be formatted: choose **Back
to SD card** first (your files can be moved along), format, then **Use this disk**
again and move the files back.

If the selected disk is missing, capturing stops with a clear message instead
of silently writing to the SD card. Use **Safely remove USB disk** before
unplugging. A USB SSD is the fastest and most durable option.

## Which disk?

A focus stack writes one ~37 MB TIFF per frame, many in a row. What matters is the
**sustained** write speed — the speed printed on a USB stick is usually only its
small fast buffer. **Settings → Storage → Speed test** measures it (writes 512 MB);
roughly, a 12 MP frame takes `37 MB ÷ sustained speed`.

Measured on a Raspberry Pi 4:

| Disk | File system | Sustained write | Per frame |
|---|---|---|---|
| 2.5" hard disk in a USB 3 enclosure | ext4 | ~50 MB/s (75-88 MB/s steady after a short dip) | ~0.8 s |
| NVMe SSD in a USB enclosure (running at USB 2) | NTFS | — | 0.7-0.8 s |
| Kingston DataTraveler 64 GB USB 3 stick ("60 MB/s") | exFAT | ~7 MB/s, jumping 3-17 MB/s | ~6 s |
| same stick | ext4 | ~3 MB/s | 13+ s |

So: **an SSD or a plain hard disk** (a small or old one is plenty — with "delete
frames after stacking" a busy evening needs a few GB). Cheap USB sticks are fine
for occasional photos but too slow for stacks, and slower still with ext4 (its
journal makes many small writes elsewhere on the stick) — use exFAT on a stick.
A hard disk needs a bit more power (a powered hub is the safe choice), spins down
when idle (the first frame after a break waits a few seconds) and should not touch
the booth, so its vibration cannot shake the camera.

## Disk space limit

New captures (photos, stacks, sweeps) stop when the capture disk is
**80 % full**, so stacking, compressing and moving always have room and the disk
never fills up completely. The header turns orange from 70 % and shows
**⛔ disk full — capturing paused** at the limit; an open stack can still be
finished and processed, and a running sweep stops and stacks the frames it has.
Delete, move or upload photos and stacks to continue.
The limit is `storage.max_used_pct` in `config.json`.

## Upload

- **Google Drive**: **Settings → Connect Google Drive**. Sign in with Google in
  the tab that opens. Afterwards Google redirects to a `http://127.0.0.1:53682/…`
  address; when you are not browsing on the Pi itself that page fails to load —
  copy the full address and paste it into the app. The app then configures an
  rclone remote. Photos and processed stacks are uploaded
  **automatically** (can be switched off).
- **NAS**: **Settings → NAS**: enter server, share and (for SMB) credentials, then
  **Mount NAS**. The share is added to `/etc/fstab` (with `nofail`, so a missing
  NAS never blocks booting) and mounted at every boot. Credentials are stored in
  `/etc/miniaturestudio/nas.cred`, readable by root only. The app refuses to copy
  when the share is not mounted, so the SD card never fills up.

Uploads run in the background as jobs, one at a time, after compression and
paused while you are shooting (see [Speed](speed.md)); manual **→ Drive** /
**→ NAS** buttons are on every photo and stack as well.
