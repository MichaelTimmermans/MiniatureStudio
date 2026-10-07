#!/usr/bin/env python3
"""Convert one raw TIFF to the final image format (PNG or JPEG).

Run by MiniatureStudio's compressor as a separate low-priority process, so the
encoding never competes with the web app (live preview, requests) inside one
Python process, and its memory is returned to the system when it exits.

    compress-image.py RAW FINAL PNG_LEVEL JPEG_QUALITY
"""
import os
import sys
from pathlib import Path

from PIL import Image


def main():
    raw, final = Path(sys.argv[1]), Path(sys.argv[2])
    png_level, jpeg_quality = int(sys.argv[3]), int(sys.argv[4])
    tmp = final.with_name(f".{final.name}.part")  # nobody sees a half-written file
    with Image.open(raw) as img:
        img.load()
        if final.suffix.lower() == ".png":
            img.save(tmp, "PNG", compress_level=png_level)
        else:
            img.convert("RGB").save(tmp, "JPEG", quality=jpeg_quality, subsampling=0)
    os.replace(tmp, final)


if __name__ == "__main__":
    main()
