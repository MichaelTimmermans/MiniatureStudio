#!/usr/bin/env python3
"""Halo-free focus stacking for miniatures on a black backdrop.

Wavelet stackers (focus-stack) pick the frame with the most detail per pixel.
Next to a bright edge on a black backdrop, the blurred rendition of that edge in
the defocused frames looks like more detail than the featureless black of the
in-focus frame, so a glow ("halo") ends up in the result. This stacker instead:

1. aligns every frame to the middle one (affine, covers focus breathing) and
   matches its brightness / colour to it;
2. measures local sharpness per frame and picks the sharpest frame per pixel
   where there is real detail;
3. where no frame shows detail (backdrop and halo zone) picks the DARKEST frame:
   right next to an in-focus edge that frame is pure black.

Works frame by frame in two passes, so memory stays around a few hundred MB for
12MP frames (fits a 1 GB Raspberry Pi 3B). Progress goes to stdout.

    halofree-stack.py --output=result.png [--depthmap=depth.png] [--threshold=40]
                      [--focus-ratio=2.0] [--halo-band=40] [--halo-margin=6] [--min-area=150]
                      [--reference=N]
                      [--pngcompression=3] [--jpgquality=95] frame1.tif ...
"""
import sys
import time

import cv2
import numpy as np

ALIGN_SCALE = 0.25    # alignment on 1/4 resolution: fast and accurate enough
SHARP_SCALE = 0.5     # sharpness map on 1/2 resolution: memory, and it is smoothed anyway
SHARP_SIGMA = 3.0     # local-energy window (in half-resolution pixels)


def log(step, total, msg):
    print(f"[{step:3d}/{total:3d}] {msg}", flush=True)


def parse_args(argv):
    opts, files = {}, []
    for a in argv:
        if a.startswith("--"):
            key, _, value = a[2:].partition("=")
            opts[key] = value
        else:
            files.append(a)
    return opts, files


def load(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    return img


def small_gray(img, scale):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)


def main():
    opts, files = parse_args(sys.argv[1:])
    if len(files) < 2 or "output" not in opts:
        raise SystemExit(__doc__)
    started = time.time()
    n = len(files)
    total = 2 * n + 2
    step = 0
    ref_i = int(opts["reference"]) if opts.get("reference", "") != "" else n // 2
    threshold = float(opts.get("threshold", 40))  # x noise floor: model detail is 100x+, backdrop noise <30x

    ref = load(files[ref_i])
    h, w = ref.shape[:2]
    ref_align = small_gray(ref, ALIGN_SCALE).astype(np.float32) / 255
    ref_small = cv2.resize(ref, None, fx=ALIGN_SCALE, fy=ALIGN_SCALE, interpolation=cv2.INTER_AREA)
    ref_mask = cv2.cvtColor(ref_small, cv2.COLOR_BGR2GRAY) > 40  # model pixels, not backdrop
    del ref

    sh, sw = int(h * SHARP_SCALE), int(w * SHARP_SCALE)
    best_s = np.zeros((sh, sw), np.float32)
    sum_s = np.zeros((sh, sw), np.float32)
    best_idx = np.zeros((sh, sw), np.uint8)
    min_l = np.full((sh, sw), 255.0, np.float32)
    ref_l = None
    dark_idx = np.zeros((sh, sw), np.uint8)
    warps, gains = [], []

    def prepare(i, img):
        """Aligned + brightness-matched full-resolution frame."""
        if warps[i] is not None:
            img = cv2.warpAffine(img, warps[i], (w, h), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP,
                                 borderMode=cv2.BORDER_REPLICATE)
        if gains[i] is not None:
            img = cv2.multiply(img, np.array([*gains[i], 0], np.float64), dtype=cv2.CV_8U)
        return img

    # Pass 1: alignment, brightness match and sharpness per frame
    for i, path in enumerate(files):
        step += 1
        img = load(path)
        warp = None
        if i != ref_i:
            warp = np.eye(2, 3, dtype=np.float32)
            crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5)
            try:
                _, warp = cv2.findTransformECC(ref_align, small_gray(img, ALIGN_SCALE).astype(np.float32) / 255,
                                               warp, cv2.MOTION_AFFINE, crit, None, 5)
                warp[:, 2] /= ALIGN_SCALE
            except cv2.error:
                log(step, total, f"WARNING: could not align {path}, using it unaligned")
                warp = None
        warps.append(warp)
        gains.append(None)
        aligned = prepare(i, img)
        del img
        if i != ref_i:
            small = cv2.resize(aligned, None, fx=ALIGN_SCALE, fy=ALIGN_SCALE, interpolation=cv2.INTER_AREA)
            g = [float(np.median(ref_small[..., c][ref_mask].astype(np.float32)
                                 / np.maximum(small[..., c][ref_mask].astype(np.float32), 1)))
                 for c in range(3)] if ref_mask.any() else [1.0, 1.0, 1.0]
            if max(abs(x - 1) for x in g) > 0.02:
                gains[i] = g
                aligned = prepare(i, load(path))
            del small
        gray = cv2.resize(cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY), (sw, sh), interpolation=cv2.INTER_AREA)
        del aligned
        gray = gray.astype(np.float32)
        lap = cv2.Laplacian(cv2.GaussianBlur(gray, (0, 0), 0.8), cv2.CV_32F, ksize=3)
        sharp = cv2.GaussianBlur(lap * lap, (0, 0), SHARP_SIGMA)
        del lap
        luma = cv2.GaussianBlur(gray, (0, 0), 1.5)
        sum_s += sharp
        better = sharp > best_s
        best_s[better] = sharp[better]
        best_idx[better] = i
        if i == ref_i:
            ref_l = luma.copy()
        darker = luma < min_l
        min_l[darker] = luma[darker]
        dark_idx[darker] = i
        del sharp, luma, gray, better, darker
        scale = np.sqrt(abs(np.linalg.det(warp[:, :2]))) if warp is not None else 1.0
        gain_txt = "" if gains[i] is None else f", gain {np.round(gains[i], 2).tolist()}"
        log(step, total, f"Analyse {path.rsplit('/', 1)[-1]} (scale {scale:.4f}{gain_txt})")

    # Decide per pixel: sharpest frame where there is detail; in a band around the
    # detail (where halos live) the darkest frame; further out one fixed frame, so
    # smooth backdrop areas do not turn into a mosaic of slightly different frames.
    step += 1
    noise = float(np.median(best_s))  # the backdrop dominates: its level is the noise floor
    # Real focus: one frame clearly sharper than the average frame. Sensor noise on a
    # smooth surface is equally "sharp" in every frame and must not count as detail.
    ratio = float(opts.get("focus-ratio", 2.0))
    peaked = best_s > ratio * (sum_s / n)
    detail = ((best_s > max(noise * threshold, 1.0)) & peaked).astype(np.uint8)
    detail = cv2.morphologyEx(detail, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # Drop isolated specks (noise that happened to peak in one frame): real model
    # detail forms large connected areas.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(detail, connectivity=8)
    min_area = int(opts.get("min-area", 150))  # half-resolution pixels
    keep = np.zeros(count, np.uint8)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    detail = keep[labels]
    del sum_s, peaked, labels
    radius = int(opts.get("halo-band", 40))  # half-resolution pixels (~80 at full size)
    band = cv2.dilate(detail, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))
    # Only a clearly darker frame wins in the band (that is a glow); small noise
    # differences keep the reference frame, so no patches of other frames appear.
    margin = float(opts.get("halo-margin", 6))  # luma levels (0-255)
    glow = (band > 0) & ((ref_l - min_l) > margin) & (min_l < 0.5 * ref_l)  # near-black vs lit: a glow
    idx = np.where(detail > 0, best_idx, np.where(glow, dark_idx, ref_i)).astype(np.uint8)
    idx = cv2.medianBlur(idx, 5)
    del band, glow, ref_l
    idx_full = cv2.resize(idx, (w, h), interpolation=cv2.INTER_NEAREST)
    log(step, total, f"Depth map: {detail.mean() * 100:.1f}% detail (noise floor {noise:.2f})")
    del best_s, best_idx, min_l, dark_idx, detail

    # Pass 2: assemble the result frame by frame
    result = np.zeros((h, w, 3), np.uint8)
    for i, path in enumerate(files):
        step += 1
        m = idx_full == i
        if m.any():
            result[m] = prepare(i, load(path))[m]
        log(step, total, f"Compose {path.rsplit('/', 1)[-1]} ({m.mean() * 100:.1f}% of pixels)")
        del m

    step += 1
    out = opts["output"]
    ext = out.rsplit(".", 1)[-1].lower()
    params = []
    if ext == "png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, int(opts.get("pngcompression", 3))]
    elif ext in ("jpg", "jpeg"):
        params = [cv2.IMWRITE_JPEG_QUALITY, int(opts.get("jpgquality", 95))]
    if not cv2.imwrite(out, result, params):
        raise SystemExit(f"cannot write {out}")
    if opts.get("depthmap"):
        depth = (idx_full.astype(np.float32) * (255 / max(n - 1, 1))).astype(np.uint8)
        cv2.imwrite(opts["depthmap"], depth)
    log(step, total, f"Save {out}")
    print(f"Saved to {out} ({w}, {h}) in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
