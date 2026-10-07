# Speed

[← Documentation](README.md)

Only the capture itself happens while you wait (about a second); everything
else runs in the background, so you can keep shooting:

1. **Live preview** uses the fast binned sensor mode and switches to full
   resolution just for the capture (Settings → Camera & performance →
   `fast`). The focus check switches to full resolution while it is on, and
   back 20 s after. See [Camera settings](camera-settings.md#preview-vs-photo)
   for the trade-offs of `fast` and `full`.
2. **Raw write**: the frame is written to disk as uncompressed TIFF right away.
3. **Compression** to PNG runs as separate low-priority processes (lowest CPU
   and disk priority), one at a time on a 1 GB Pi, two on 2 GB, one per spare
   core above that (PNG encoding of a 12 MP frame takes 10-15 s on a Pi 3B).
   Stack frames are never compressed if they are deleted after stacking — the
   stacker reads the TIFFs directly.
4. **Stacking** runs as jobs, one stack at a time, at low priority so the camera
   and UI stay responsive.
5. **Uploads** run one at a time, after compression (a stack whose frames are
   uploaded goes once all its frames are compressed), and wait while you are
   capturing, stacking or using the focus check, so they never compete with the
   live preview for Wi-Fi and the USB bus. The **Jobs** tab shows all jobs.

The header shows **✓ idle** or **⚙ busy** (hover for what is running, click for
the Jobs tab), plus a **CPU · RAM · temperature** pill; it turns orange when the
Pi is short on memory (swapping) or hot — then it reacts slowly. Click it for
the System tab. Set the image
format to `tif` to skip compression entirely (files ~1.8× larger); TIFF files
then get a **Download PNG** button that compresses on download.

Cropping (see [Cropping](cropping.md)) also speeds everything up: fewer pixels
to write, compress and stack.
