# Storage and upload

[← Documentation](README.md)

## File names

A pattern in Python `str.format` syntax (Settings → Files), e.g.
`{dt:%Y%m%d_%H%M%S}_{label}` or `{seq:04d}_{label}`. `{label}` is what you type
on the Capture tab; `{seq}` increments every time it is used.

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

If the selected disk is missing, capturing stops with a clear message instead
of silently writing to the SD card. Use **Safely remove USB disk** before
unplugging. A USB SSD is the fastest and most durable option.

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
