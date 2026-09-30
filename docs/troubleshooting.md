# Troubleshooting

[← Documentation](README.md)

## System tab and logs

The **System** tab shows the Pi model, OS, CPU load/temperature/clock, memory,
swap, disk space and app version, plus warnings for **under-voltage /
throttling** (from `vcgencmd get_throttled`). The **Log** window shows the
app's journal, including libcamera's own messages. **Download debug log** puts
system info, settings, recent jobs, the app log and kernel messages in one text
file — the first thing to grab when something goes wrong. Restart app, reboot
and shut down are there too.

## Common problems

- **The photo is darker or brighter than the preview** — check the capture line
  in System → Log (filter `capture`): it shows preview vs photo exposure and
  gain. With fully manual exposure the fast preview is brighter than the photo;
  use Live preview → `full` for an exact match. See
  [Camera settings](camera-settings.md#preview-vs-photo).
- **No live preview, header says the camera sends no image** — the camera is
  detected but no frames arrive (log: "Camera frontend has timed out"): reseat
  the ribbon cable at both ends with the Pi switched off, check it is not
  pinched or reversed.
- **Under-voltage warning** — the power supply (or power HAT input) is too weak;
  the Pi slows down and the SD card is at risk. Use a proper supply.
- **Stacking fails with "exit code -9" / out of memory** — make sure there is
  swap (see [Hardware](hardware.md#raspberry-pi-3b-notes)), keep threads on
  auto, or use the halo-free method (default).
- **A glow around the model after stacking** — see
  [Focus stacking](focus-stacking.md#tips-for-sharp-stacks-without-halos).
- **Captures sometimes take several seconds** — in fast preview mode each capture
  reserves ~55 MB of camera memory, which can be slow on a 1 GB Pi right after
  background compression. Live preview → `full` avoids it.
- **The page briefly says "focus-stack missing" after an update** — it was opened
  while the app restarted; it retries by itself.

## Handy commands

```bash
rpicam-hello --list-cameras                         # is the camera detected?
journalctl -u miniaturestudio -b --no-pager | grep -v werkzeug | tail -60
miniaturestudio-update                              # update from a terminal
systemd-analyze blame | head -15                    # what slows booting down
```
