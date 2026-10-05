#!/usr/bin/env python3
"""MiniatureStudio — Flask + picamera2 web app.

Single global camera backend guarded by ``camera_lock``. Still configuration is
dual-stream (``main`` = full sensor resolution for captures, ``lores`` = MJPEG
preview), so photos never interrupt the live preview. Video temporarily
reconfigures the camera. Focus stacking uses the vendored focus-stack binary
(vendor/focus-stack) in a background job.
"""
import atexit
import io
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request, send_file

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
EXAMPLE_CONFIG_PATH = BASE_DIR / "config.example.json"
VENDORED_FOCUS_STACK = BASE_DIR / "vendor" / "focus-stack" / "build" / "focus-stack"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".h264", ".avi"}

log = logging.getLogger("miniaturestudio")
app = Flask(__name__)

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------

config_lock = threading.RLock()


def deep_merge(base, override):
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load_config():
    if not CONFIG_PATH.exists():
        shutil.copy(EXAMPLE_CONFIG_PATH, CONFIG_PATH)
    defaults = json.loads(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
    user = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return deep_merge(defaults, user)


CONFIG = load_config()


def save_config():
    with config_lock:
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(CONFIG, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)


USB_MOUNT = Path("/mnt/miniaturestudio-usb")  # managed by scripts/miniaturestudio-mount
DATA_KINDS = ("photos", "stacks", "videos")


class StorageUnavailable(RuntimeError):
    """The selected storage (USB disk) is not connected."""


_usb_remount = {"at": 0.0}


def usb_root(try_remount=True):
    """Data folder on the USB disk; re-mounts it once when it was replugged."""
    if not os.path.ismount(USB_MOUNT) and try_remount and time.time() - _usb_remount["at"] > 10:
        _usb_remount["at"] = time.time()
        try:
            run_mount_helper("usb-remount")
        except Exception as exc:
            log.info("USB remount: %s", exc)
    if not os.path.ismount(USB_MOUNT):
        raise StorageUnavailable("USB disk not connected — plug it in, or switch back to the SD card "
                                 "under Settings → Storage")
    return USB_MOUNT / "MiniatureStudio"


def sd_dir(key):
    path = Path(CONFIG["paths"][key])
    return path if path.is_absolute() else BASE_DIR / path


def storage_target():
    return CONFIG.get("storage", {}).get("target", "sd")


def data_dir(key):
    path = usb_root() / key if storage_target() == "usb" else sd_dir(key)
    path.mkdir(parents=True, exist_ok=True)
    return path


# --------------------------------------------------------------------------
# File naming
# --------------------------------------------------------------------------

UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def sanitize(text):
    text = UNSAFE_CHARS.sub("_", (text or "").strip())
    return re.sub(r"_{2,}", "_", text).strip("._-")


def format_name(pattern, label, seq, now=None):
    name = pattern.format(dt=now or datetime.now(), label=sanitize(label), seq=seq)
    return sanitize(name)


def build_basename(label):
    """Render the filename pattern; bumps the {seq} counter when it is used."""
    with config_lock:
        pattern = CONFIG["filename_pattern"]
        seq = int(CONFIG.get("next_seq", 1))
        name = format_name(pattern, label, seq)
        if "{seq" in pattern:
            CONFIG["next_seq"] = seq + 1
            save_config()
    return name or datetime.now().strftime("%Y%m%d_%H%M%S")


def unique_stem(directory, stem, ext):
    """Never overwrite: append _2, _3, ... when the name is taken."""
    candidate, n = stem, 2
    while ((directory / f"{candidate}{ext}").exists() or (directory / candidate).exists()
           or (directory / f"{candidate}.tif").exists()
           or (save_queue and save_queue.is_pending(f"{candidate}{ext}"))):
        candidate = f"{stem}_{n}"
        n += 1
    return candidate


def safe_child(directory, name):
    """Resolve ``name`` inside ``directory``; 404 on anything that escapes it."""
    target = (directory / name).resolve()
    if directory.resolve() not in target.parents or not target.exists():
        abort(404)
    return target


def image_ext():
    fmt = CONFIG.get("image_format", "png").lower()
    return {"jpg": ".jpg", "jpeg": ".jpg", "tif": ".tif", "tiff": ".tif"}.get(fmt, ".png")


# --------------------------------------------------------------------------
# Camera controls description
# --------------------------------------------------------------------------

# libcamera enum values -> readable labels (courant libcamera convention).
ENUM_CONTROLS = {
    "AeMeteringMode": {0: "CentreWeighted", 1: "Spot", 2: "Matrix", 3: "Custom"},
    "AeConstraintMode": {0: "Normal", 1: "Highlight", 2: "Shadows", 3: "Custom"},
    "AeExposureMode": {0: "Normal", 1: "Short", 2: "Long", 3: "Custom"},
    "AeFlickerMode": {0: "Off", 1: "Manual", 2: "Auto"},
    "AwbMode": {0: "Auto", 1: "Incandescent", 2: "Tungsten", 3: "Fluorescent",
                4: "Indoor", 5: "Daylight", 6: "Cloudy", 7: "Custom"},
    "AfMode": {0: "Manual", 1: "Auto", 2: "Continuous"},
    "AfRange": {0: "Normal", 1: "Macro", 2: "Full"},
    "AfSpeed": {0: "Normal", 1: "Fast"},
    "AfMetering": {0: "Auto", 1: "Windows"},
    "NoiseReductionMode": {0: "Off", 1: "Fast", 2: "HighQuality", 3: "Minimal", 4: "ZSL"},
    "HdrMode": {0: "Off", 1: "MultiExposureUnmerged", 2: "MultiExposure",
                3: "SingleExposure", 4: "Night"},
}

# Controls whose value is a fixed-length list although min/max are scalars.
ARRAY_CONTROLS = {"ColourGains": 2, "FrameDurationLimits": 2, "ColourCorrectionMatrix": 9}

# Actions rather than settings; handled by dedicated buttons or not useful.
# Actions, and controls for other hardware (AI camera tensors, multi-camera sync).
HIDDEN_CONTROLS = {"AfTrigger", "AfPause", "AfWindows", "CnnEnableInputTensor", "CnnInputTensor",
                   "CnnInputTensorInfo", "StatsOutputEnable", "SyncMode", "SyncFrames"}


def jsonable(value):
    if isinstance(value, (bool, int, float, str)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    try:
        return [jsonable(v) for v in value]
    except TypeError:
        return str(value)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def describe_controls(camera_controls, current):
    described = []
    for name in sorted(camera_controls):
        if name in HIDDEN_CONTROLS:
            continue
        mn, mx, default = camera_controls[name]
        entry = {
            "name": name,
            "min": jsonable(mn),
            "max": jsonable(mx),
            "default": jsonable(default),
            "value": jsonable(current.get(name, default)),
        }
        if name in ENUM_CONTROLS:
            options = ENUM_CONTROLS[name]
            if is_number(mn) and is_number(mx):
                options = {k: v for k, v in options.items() if mn <= k <= mx}
            entry["type"] = "enum"
            entry["options"] = [{"value": k, "label": v} for k, v in options.items()]
        elif isinstance(mn, bool) or isinstance(default, bool):
            entry["type"] = "bool"
        elif name in ARRAY_CONTROLS and is_number(mn) and is_number(mx):
            entry["type"] = "array"
            entry["length"] = ARRAY_CONTROLS[name]
            entry["numeric"] = "float" if isinstance(mn, float) or isinstance(mx, float) else "int"
        elif is_number(mn) and is_number(mx):
            entry["type"] = "float" if any(isinstance(v, float) for v in (mn, mx, default)) else "int"
        else:
            entry["type"] = "json"
        described.append(entry)
    return described


def coerce_control(name, value, info):
    mn, mx, default = info
    if isinstance(value, str) and value.strip()[:1] in "[{":
        value = json.loads(value)
    if name in ARRAY_CONTROLS:
        cast = float if isinstance(mn, float) or isinstance(mx, float) else int
        return tuple(cast(v) for v in value)
    if isinstance(mn, bool) or isinstance(default, bool):
        if isinstance(value, str):
            return value.lower() in ("1", "true", "on", "yes")
        return bool(value)
    if any(isinstance(v, float) for v in (mn, mx, default)):
        return float(value)
    if is_number(mn):
        return int(round(float(value)))
    if isinstance(value, list):
        return tuple(value)
    return value


# --------------------------------------------------------------------------
# Camera backends
# --------------------------------------------------------------------------

camera_lock = threading.Lock()


class StreamingOutput(io.BufferedIOBase):
    """Holds the latest MJPEG frame for /stream.mjpg clients."""

    def __init__(self):
        self.frame = None
        self.condition = threading.Condition()
        self.started = time.time()
        self.last_frame = 0.0

    def write(self, buf):
        with self.condition:
            self.frame = bytes(buf)
            self.last_frame = time.time()
            self.condition.notify_all()
        return len(buf)

    def seconds_without_frames(self):
        """How long the preview has been silent (a camera that delivers no frames)."""
        return round(time.time() - max(self.last_frame, self.started), 1)


class RealCamera:
    demo = False
    bgr_arrays = True  # picamera2 "RGB888" arrays are BGR ordered

    def __init__(self, index=0, stream=None):
        from picamera2 import Picamera2
        from picamera2.outputs import FfmpegOutput, FileOutput

        self._FfmpegOutput, self._FileOutput = FfmpegOutput, FileOutput
        self._pick_encoders()
        self.index = index
        self.picam2 = Picamera2(index)
        self.model = self.picam2.camera_properties.get("Model", f"camera{index}")
        self.stream = stream or StreamingOutput()  # shared so open preview tabs survive a switch
        self.applied = {}
        self.hold_full = False  # focus check wants real 100% crops
        self.mode = None        # "preview" (binned, fast) or "full"
        self.sensor_modes = self._list_sensor_modes()
        self.start_still_mode()

    def _list_sensor_modes(self):
        """Sensor mode sizes from the raw format list. Deliberately not Picamera2's
        sensor_modes property: that configures the camera in every mode (incl. full-res
        raw), which on a Pi 3B left too little camera memory for the preview encoder."""
        try:
            from libcamera import StreamRole

            formats = self.picam2.camera.generate_configuration([StreamRole.Raw]).at(0).formats
            sizes = {(s.width, s.height) for pf in formats.pixel_formats for s in formats.sizes(pf)}
            return [{"size": list(s)} for s in sorted(sizes, key=lambda s: -s[0] * s[1])]
        except Exception as exc:
            log.warning("Could not list sensor modes: %s", exc)
            return []

    def _pick_encoders(self):
        """Pi 3/4 (VC4) have hardware MJPEG/H.264 encoders; the Pi 5 does not."""
        from picamera2 import encoders

        pisp = False
        try:
            from picamera2.platform import Platform, get_platform
            pisp = get_platform() == Platform.PISP
        except ImportError:
            pass
        if pisp:
            self._make_preview_encoder = lambda: encoders.JpegEncoder(q=80)
            libav = getattr(encoders, "LibavH264Encoder", None)
            self._H264Encoder = libav or encoders.H264Encoder
        else:
            self._make_preview_encoder = encoders.MJPEGEncoder
            self._H264Encoder = encoders.H264Encoder

    # -- modes --------------------------------------------------------------
    @property
    def fast_preview(self):
        return CONFIG["camera"].get("preview_mode", "fast") == "fast" and not self.hold_full

    def _with_controls(self, cfg):
        # Controls in the config apply from the very first frame after start().
        cfg["controls"] = {**(cfg.get("controls") or {}),
                           **effective_controls(self.applied, self.picam2.camera_controls)}
        return cfg

    def _still_config(self, with_lores=True):
        cam = CONFIG["camera"]
        main_size = tuple(cam.get("still_size") or self.picam2.sensor_resolution)
        extra = {"lores": {"size": tuple(cam["preview_size"]), "format": "YUV420"}} if with_lores else {}
        return self._with_controls(self.picam2.create_still_configuration(
            main={"size": main_size, "format": "RGB888"},
            display=None,
            buffer_count=int(cam.get("buffer_count", 2)) if with_lores else 1,
            queue=False,  # captures always use a frame taken after the click
            **extra,
        ))

    def _preview_config(self):
        """Binned sensor mode (2028x1520 on the HQ camera): many more fps than full-res."""
        w, h = self.picam2.sensor_resolution
        binned = (w // 2 // 2 * 2, h // 2 // 2 * 2)
        cfg = self.picam2.create_preview_configuration(
            main={"size": tuple(CONFIG["camera"]["preview_size"]), "format": "YUV420"},
            sensor={"output_size": binned},
            display=None,
            buffer_count=4,
        )
        # Picamera2's preview preset caps frames at 83 ms, i.e. the exposure time: the
        # preview would then be darker than the photo. Allow the same range as stills.
        cfg["controls"]["FrameDurationLimits"] = (100, 1_000_000)
        return self._with_controls(cfg)

    def _apply_saved_controls(self):
        if self.applied:
            try:
                self.picam2.set_controls(effective_controls(self.applied, self.picam2.camera_controls))
            except Exception as exc:  # e.g. a control invalid in video mode
                log.warning("Could not re-apply controls: %s", exc)

    def start_still_mode(self):
        """Idle mode with live preview: binned for speed, or full-res dual-stream."""
        if self.fast_preview:
            self.picam2.configure(self._preview_config())
            stream_name, self.mode = "main", "preview"
        else:
            self.picam2.configure(self._still_config())
            stream_name, self.mode = "lores", "full"
        self.picam2.start_encoder(self._make_preview_encoder(), self._FileOutput(self.stream), name=stream_name)
        self.picam2.start()
        self._apply_saved_controls()

    def set_hold_full(self, on):
        if on != self.hold_full:
            self.hold_full = on
            if CONFIG["camera"].get("preview_mode", "fast") == "fast":
                self.stop_all()
                self.start_still_mode()

    def stop_all(self):
        self.picam2.stop_recording()  # stops every encoder and the camera

    # -- info ---------------------------------------------------------------
    @property
    def camera_controls(self):
        return self.picam2.camera_controls

    @property
    def has_autofocus(self):
        return "AfMode" in self.picam2.camera_controls and "LensPosition" in self.picam2.camera_controls

    @property
    def sensor_resolution(self):
        return tuple(self.picam2.sensor_resolution)

    def metadata(self):
        return self.picam2.capture_metadata()

    # -- controls -----------------------------------------------------------
    def set_controls(self, controls):
        self.picam2.set_controls(controls)
        self.applied.update(controls)

    def reset_controls(self):
        defaults = {name: info[2] for name, info in self.camera_controls.items()
                    if name not in HIDDEN_CONTROLS and info[2] is not None}
        self.applied = {}
        try:
            self.picam2.set_controls(defaults)
        except Exception as exc:
            log.warning("Resetting some controls failed: %s", exc)

    # -- capture ------------------------------------------------------------
    @property
    def auto_adjusting(self):
        """True while auto exposure or auto white balance can still change the image."""
        a, cc = self.applied, self.picam2.camera_controls
        return exposure_is_auto(a, cc) or gain_is_auto(a, cc) or a.get("AwbEnable", True) is not False

    def grab(self):
        """Take one full-resolution frame -> (PIL image, metadata). Saving happens elsewhere."""
        switched = self.mode == "preview"
        preview_md = {}
        if switched:
            try:
                preview_md = self.picam2.capture_metadata()
            except Exception:
                pass
            # Preview runs binned: switch to the full sensor mode for this one frame.
            self.stop_all()
            self.picam2.configure(self._still_config(with_lores=False))
            self.picam2.start()
        skipped = 0
        try:
            req = self.picam2.capture_request()
            # After a mode switch auto exposure / white balance need a few frames to
            # settle; the first frame can be a stop off (seen in real stacks). Wait until
            # two consecutive frames agree, at most 6 frames. Manual settings: no wait.
            while switched and self.auto_adjusting and skipped < 10:
                md = req.get_metadata()
                req.release()
                req = self.picam2.capture_request()
                skipped += 1
                new_md = req.get_metadata()
                converged = ae_converged(new_md)
                if converged or (converged is None and skipped >= 3 and exposure_settled(md, new_md)):
                    break
            try:
                image = req.make_image("main")  # copies the buffer
                metadata = req.get_metadata()
            finally:
                req.release()
        finally:
            if switched:
                self.picam2.stop()
                self.start_still_mode()
        if preview_md:
            log.info("capture: preview %s -> photo %s (%d settle frames)",
                     exposure_summary(preview_md), exposure_summary(metadata), skipped)
        return image, metadata

    def capture_crop(self, x, y, cw, ch):
        """100% crop around (x, y) (0..1) from the main stream without copying the full
        12MP frame — the focus check runs every second."""
        from picamera2 import MappedArray

        req = self.picam2.capture_request()
        try:
            with MappedArray(req, "main") as m:
                h, w = m.array.shape[:2]
                cw, ch = min(cw, w), min(ch, h)
                left = int(min(max(x * w - cw / 2, 0), w - cw))
                top = int(min(max(y * h - ch / 2, 0), h - ch))
                return m.array[top:top + ch, left:left + cw, :3].copy()
        finally:
            req.release()

    def capture(self, path):
        image, metadata = self.grab()
        save_image(image, path)
        return metadata

    def capture_main_array(self):
        return self.picam2.capture_array("main")

    def autofocus(self):
        previous = self.applied.get("AfMode")
        self.picam2.set_controls({"AfMode": 1})
        ok = self.picam2.autofocus_cycle()
        lens = self.picam2.capture_metadata().get("LensPosition")
        if previous in (None, 0) and lens is not None:
            # Lock the found position in manual mode — convenient for stacking.
            self.set_controls({"AfMode": 0, "LensPosition": lens})
        return ok, lens

    # -- video --------------------------------------------------------------
    def start_video(self, stem, directory):
        vid = CONFIG["video"]
        self.stop_all()
        cfg = self.picam2.create_video_configuration(
            main={"size": tuple(vid["size"]), "format": "YUV420"},
            lores={"size": tuple(vid["preview_size"]), "format": "YUV420"},
            display=None,
            encode="main",
        )
        self.picam2.configure(cfg)
        if shutil.which("ffmpeg"):
            path = directory / f"{stem}.mp4"
            output = self._FfmpegOutput(str(path))
        else:
            path = directory / f"{stem}.h264"
            output = self._FileOutput(str(path))
        self.picam2.start_encoder(self._H264Encoder(bitrate=int(vid["bitrate"])), output, name="main")
        self.picam2.start_encoder(self._make_preview_encoder(), self._FileOutput(self.stream), name="lores")
        self.picam2.start()
        self._apply_saved_controls()
        self.mode = "video"
        return path

    def stop_video(self):
        self.stop_all()
        self.start_still_mode()

    def close(self):
        try:
            self.stop_all()
            self.picam2.close()
        except Exception:
            pass


def exposure_is_auto(controls, cc):
    """Auto exposure time? Newer libcamera: ExposureTimeMode (0 auto, 1 manual); older: AeEnable."""
    if "ExposureTimeMode" in cc:
        return controls.get("ExposureTimeMode", 0) != 1
    return controls.get("AeEnable", True) is not False


def gain_is_auto(controls, cc):
    if "AnalogueGainMode" in cc:
        return controls.get("AnalogueGainMode", 0) != 1
    return controls.get("AeEnable", True) is not False


def effective_controls(controls, cc):
    """Drop manual values that do not apply while the matching setting is automatic.

    Stale ExposureTime / AnalogueGain values (from a slider, a preset or an old lock)
    otherwise fight auto exposure: seen as a preview at 6.7 ms with gain 16 and a photo
    started at gain 1.0, four stops darker than the preview."""
    out = dict(controls)
    if exposure_is_auto(out, cc):
        out.pop("ExposureTime", None)
    if gain_is_auto(out, cc):
        out.pop("AnalogueGain", None)
    if out.get("AwbEnable", True) is not False:
        out.pop("ColourGains", None)
        out.pop("ColourTemperature", None)
    return out


def ae_converged(md):
    """libcamera's own verdict when available (AeState 2 = converged, or AeLocked)."""
    if "AeState" in md:
        return md["AeState"] == 2
    if "AeLocked" in md:
        return bool(md["AeLocked"])
    return None


def crop_box(size):
    """Pixel box (left, top, right, bottom) of the configured crop, or None.
    The crop is stored as a normalised rectangle (0..1) of the full frame."""
    c = CONFIG.get("crop") or {}
    if not c.get("enabled"):
        return None
    w_img, h_img = size
    try:
        x, y, w, h = (float(c[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if w <= 0 or h <= 0 or (w >= 0.999 and h >= 0.999):
        return None
    left = int(round(max(0.0, min(1.0, x)) * w_img))
    top = int(round(max(0.0, min(1.0, y)) * h_img))
    right = min(w_img, left + max(16, int(round(w * w_img))) // 2 * 2)  # even sizes
    bottom = min(h_img, top + max(16, int(round(h * h_img))) // 2 * 2)
    return left, top, right, bottom


def apply_crop(image):
    """Cut the configured crop out of a captured frame (cheap: a copy of the region).
    Also makes saving, compressing and stacking faster — fewer pixels."""
    box = crop_box(image.size)
    return (image.crop(box), box) if box else (image, None)


def exposure_summary(md):
    parts = []
    if md.get("ExposureTime"):
        parts.append(f"{md['ExposureTime'] / 1000:.1f}ms")
    if md.get("AnalogueGain"):
        parts.append(f"gain {md['AnalogueGain']:.2f}")
    if md.get("ColourGains"):
        parts.append("wb " + "/".join(f"{g:.2f}" for g in md["ColourGains"]))
    return " ".join(parts) or "?"


def exposure_settled(a, b, tolerance=0.03):
    """Two consecutive frames with (nearly) the same exposure, gain and white balance."""
    def close(x, y):
        if x is None or y is None:
            return True
        return abs(x - y) <= tolerance * max(abs(x), abs(y), 1e-6)
    pairs = [(a.get("ExposureTime"), b.get("ExposureTime")), (a.get("AnalogueGain"), b.get("AnalogueGain"))]
    pairs += list(zip(a.get("ColourGains") or (), b.get("ColourGains") or ()))
    return all(close(x, y) for x, y in pairs)


class DemoCamera:
    """Stand-in when picamera2 is unavailable (e.g. developing on a PC)."""

    demo = True
    bgr_arrays = False
    sensor_modes = [{"size": [2028, 1520], "fps": 40.0, "bit_depth": 12},
                    {"size": [1014, 760], "fps": 120.0, "bit_depth": 10}]
    sensor_resolution = (2028, 1520)
    has_autofocus = True  # so the sweep UI can be exercised without hardware

    camera_controls = {
        "AeEnable": (False, True, True),
        "AfMode": (0, 2, 0),
        "LensPosition": (0.0, 15.0, 1.0),
        "AnalogueGain": (1.0, 22.26, 1.0),
        "AwbEnable": (False, True, True),
        "AwbMode": (0, 7, 0),
        "AeMeteringMode": (0, 3, 0),
        "Brightness": (-1.0, 1.0, 0.0),
        "ColourGains": (0.0, 32.0, None),
        "Contrast": (0.0, 32.0, 1.0),
        "ExposureTime": (114, 694422939, None),
        "ExposureValue": (-8.0, 8.0, 0.0),
        "FrameDurationLimits": (100, 694434742, None),
        "NoiseReductionMode": (0, 4, 0),
        "Saturation": (0.0, 32.0, 1.0),
        "ScalerCrop": ((0, 0, 0, 0), (0, 0, 4056, 3040), (2, 0, 4052, 3040)),
        "Sharpness": (0.0, 16.0, 1.0),
    }

    index = 0
    model = "demo"

    def __init__(self, index=0, stream=None):
        self.stream = stream or StreamingOutput()
        self.applied = {}
        self.recording_path = None
        self.closed = False
        threading.Thread(target=self._frames, daemon=True).start()

    def _render(self, size):
        from PIL import Image, ImageDraw

        w, h = size
        img = Image.new("RGB", size, (18, 18, 22))
        draw = ImageDraw.Draw(img)
        t = time.time()
        cx, cy = w // 2 + int(w * 0.05 * __import__("math").sin(t)), h // 2
        r = h // 5
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(160, 70, 40), outline=(230, 200, 120), width=max(2, w // 300))
        for i in range(0, w, max(8, w // 64)):
            draw.line((i, h - h // 8, i + w // 128, h), fill=(90, 90, 90))
        draw.text((10, 10), f"DEMO {datetime.now():%H:%M:%S}", fill=(255, 255, 255))
        draw.text((10, 26), json.dumps(jsonable(self.applied))[:120], fill=(180, 180, 180))
        if self.recording_path:
            draw.ellipse((w - 30, 10, w - 10, 30), fill=(220, 0, 0))
        return img

    def _frames(self):
        while not self.closed:
            buf = io.BytesIO()
            self._render(tuple(CONFIG["camera"]["preview_size"])).save(buf, "JPEG", quality=80)
            self.stream.write(buf.getvalue())
            time.sleep(0.2)

    def metadata(self):
        return {"ExposureTime": 20000, "AnalogueGain": 1.0, "ColourTemperature": 5200,
                "Lux": 400.0, "SensorTimestamp": time.monotonic_ns(), **self.applied}

    def set_controls(self, controls):
        self.applied.update(controls)

    def reset_controls(self):
        self.applied = {}

    mode = "preview"
    hold_full = False

    def set_hold_full(self, on):
        pass

    def grab(self):
        time.sleep(0.6)  # roughly a real mode switch + exposure, so the UI overlay is visible
        return self._render(self.sensor_resolution), self.metadata()

    def capture(self, path):
        image, metadata = self.grab()
        save_image(image, path)
        return metadata

    def capture_main_array(self):
        import numpy as np
        return np.asarray(self._render(self.sensor_resolution))

    def autofocus(self):
        self.applied.update({"AfMode": 0, "LensPosition": 5.0})
        return True, 5.0

    def start_video(self, stem, directory):
        self.recording_path = directory / f"{stem}.mp4"
        self.recording_path.write_bytes(b"")  # placeholder, demo only
        return self.recording_path

    def stop_video(self):
        self.recording_path = None

    def close(self):
        self.closed = True


class USBCamera:
    """UVC webcam through Picamera2/libcamera: a single stream, no ISP tricks.

    MJPEG webcams send finished JPEG frames: the preview passes them straight to the
    browser and video copies them into a file with ffmpeg, so a Pi 3B does no
    encoding at all. YUYV-only webcams work for preview and photos (no video)."""

    demo = False
    bgr_arrays = False
    has_autofocus = False
    hold_full = False
    PREVIEW_FPS = 10

    def __init__(self, index=0, stream=None):
        from picamera2 import Picamera2

        self.index = index
        self.picam2 = Picamera2(index)
        self.model = self.picam2.camera_properties.get("Model", f"usb{index}")
        self.stream = stream or StreamingOutput()
        self.applied = {}
        self.mode = "usb"
        self.format, self.size = self._pick_format()
        cfg = self.picam2.create_still_configuration(
            main={"size": self.size, "format": self.format}, display=None, buffer_count=3, queue=False)
        self.picam2.configure(cfg)
        self.picam2.start()
        self._still_wanted = threading.Event()
        self._still = None
        self._still_ready = threading.Event()
        self._recorder = None
        self._closed = False
        threading.Thread(target=self._loop, daemon=True, name="usb-camera").start()
        log.info("USB camera %s: %s %sx%s", self.model, self.format, *self.size)

    def _pick_format(self):
        """Largest MJPEG size (else YUYV) the webcam offers, or camera.usb_size."""
        from libcamera import StreamRole

        formats = self.picam2.camera.generate_configuration([StreamRole.StillCapture]).at(0).formats
        offered = {str(pf): [(s.width, s.height) for s in formats.sizes(pf)] for pf in formats.pixel_formats}
        wanted = CONFIG["camera"].get("usb_size")
        for fmt in ("MJPEG", "YUYV"):
            sizes = offered.get(fmt)
            if sizes:
                if wanted and tuple(wanted) in sizes:
                    return fmt, tuple(wanted)
                return fmt, max(sizes, key=lambda s: s[0] * s[1])
        raise RuntimeError(f"webcam offers no MJPEG/YUYV format ({', '.join(offered)})")

    @property
    def camera_controls(self):
        return self.picam2.camera_controls

    @property
    def sensor_resolution(self):
        return self.size

    sensor_modes = []

    def _decode(self, req):
        if self.format == "MJPEG":
            from PIL import Image
            return Image.open(io.BytesIO(req.make_buffer("main").tobytes())).convert("RGB")
        import cv2
        from PIL import Image
        w, h = self.size
        arr = req.make_array("main")
        arr = arr.reshape(arr.shape[0], -1)[:h, :w * 2].reshape(h, w, 2)
        return Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_YUV2RGB_YUYV))

    def _preview_jpeg(self, req):
        if self.format == "MJPEG":
            return req.make_buffer("main").tobytes()
        buf = io.BytesIO()
        img = self._decode(req)
        img.thumbnail(tuple(CONFIG["camera"]["preview_size"]))
        img.save(buf, "JPEG", quality=80)
        return buf.getvalue()

    def _loop(self):
        last_preview = 0.0
        while not self._closed:
            try:
                req = self.picam2.capture_request()
            except Exception as exc:
                log.warning("USB camera: %s", exc)
                time.sleep(1)
                continue
            try:
                if self._still_wanted.is_set():  # a photo: the first frame after the click
                    self._still = (self._decode(req), req.get_metadata())
                    self._still_wanted.clear()
                    self._still_ready.set()
                rec = self._recorder
                if rec and self.format == "MJPEG":
                    try:
                        rec.stdin.write(req.make_buffer("main").tobytes())
                    except (BrokenPipeError, OSError):
                        log.warning("USB video: ffmpeg stopped")
                        self._recorder = None
                now = time.time()
                if now - last_preview >= 1 / self.PREVIEW_FPS:
                    last_preview = now
                    self.stream.write(self._preview_jpeg(req))
            except Exception:
                log.exception("USB camera frame failed")
            finally:
                req.release()

    def metadata(self):
        return self.picam2.capture_metadata()

    def set_controls(self, controls):
        self.picam2.set_controls(controls)
        self.applied.update(controls)

    def reset_controls(self):
        defaults = {name: info[2] for name, info in self.camera_controls.items()
                    if name not in HIDDEN_CONTROLS and info[2] is not None}
        self.applied = {}
        try:
            self.picam2.set_controls(defaults)
        except Exception as exc:
            log.warning("Resetting some controls failed: %s", exc)

    def set_hold_full(self, on):
        pass

    def grab(self):
        self._still_ready.clear()
        self._still_wanted.set()
        if not self._still_ready.wait(10):
            raise RuntimeError("the USB camera delivered no frame")
        return self._still

    def capture(self, path):
        image, metadata = self.grab()
        save_image(image, path)
        return metadata

    def capture_main_array(self):
        import numpy as np
        return np.asarray(self.grab()[0])

    def autofocus(self):
        return False, None

    def start_video(self, stem, directory):
        if self.format != "MJPEG":
            raise RuntimeError("video needs a webcam with MJPEG output")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("video from a USB camera needs ffmpeg (sudo apt install ffmpeg)")
        path = directory / f"{stem}.avi"
        # -c copy: the webcam's JPEG frames go into the file untouched (no CPU cost).
        self._recorder = subprocess.Popen(
            [ffmpeg, "-loglevel", "error", "-f", "mjpeg", "-framerate", "30", "-i", "-", "-c", "copy", str(path)],
            stdin=subprocess.PIPE)
        self.mode = "video"
        return path

    def stop_video(self):
        rec, self._recorder = self._recorder, None
        if rec:
            rec.stdin.close()
            rec.wait(timeout=30)
        self.mode = "usb"

    def close(self):
        self._closed = True
        try:
            self.stop_video()
            self.picam2.stop()
            self.picam2.close()
        except Exception:
            pass


class NoCamera(DemoCamera):
    """Stand-in when the real camera cannot be opened, so the web app still starts:
    the preview explains the problem and Camera sensor setup / System (logs, reboot)
    stay reachable to fix it. Captures fail with the reason."""

    demo = False
    has_autofocus = False
    camera_controls = {}
    sensor_modes = []
    model = "no camera"

    def __init__(self, error, stream=None):
        self.error = str(error)
        super().__init__(stream=stream)

    def _render(self, size):
        from PIL import Image, ImageDraw
        import textwrap

        w, h = size
        img = Image.new("RGB", size, (24, 10, 10))
        draw = ImageDraw.Draw(img)
        lines = ["NO CAMERA", ""] + textwrap.wrap(self.error, 60) + [
            "", "Check the ribbon cable (Pi switched off), Camera -> Camera sensor setup,",
            "or System -> Log. Then restart the app or reboot."]
        for i, line in enumerate(lines):
            draw.text((20, 20 + i * 18), line, fill=(255, 120, 120) if i == 0 else (230, 230, 230))
        return img

    def metadata(self):
        return {}

    def grab(self):
        raise RuntimeError(f"no camera: {self.error}")

    def capture_main_array(self):
        raise RuntimeError(f"no camera: {self.error}")

    def start_video(self, stem, directory):
        raise RuntimeError(f"no camera: {self.error}")


def save_image(image, path):
    """Write via a hidden temp name + rename, so nobody sees a half-written file."""
    ext = path.suffix.lower()
    tmp = path.with_name(f".{path.name}.part")
    if ext == ".png":
        image.save(tmp, "PNG", compress_level=int(CONFIG.get("png_compress_level", 1)))
    elif ext in (".jpg", ".jpeg"):
        image.convert("RGB").save(tmp, "JPEG", quality=int(CONFIG.get("jpeg_quality", 95)), subsampling=0)
    else:
        image.save(tmp, "TIFF")  # uncompressed: the fastest lossless option on a slow Pi
    os.replace(tmp, path)


def raw_path_for(final_path):
    """Stage-1 file: uncompressed TIFF next to where the final file will be."""
    return final_path if final_path.suffix.lower() in (".tif", ".tiff") else final_path.with_suffix(".tif")


class SaveQueue:
    """Stage 1 of saving: write each grabbed frame to disk as uncompressed TIFF as
    fast as the SD card allows, freeing its ~36 MB of RAM. Compression to the
    configured format (PNG encoding a 12MP frame takes >10 s on a Pi 3B) happens
    later in the Compressor. Bounded, so a burst of captures waits instead of
    running out of memory."""

    def __init__(self, maxsize):
        import queue

        self.queue = queue.Queue(maxsize=max(1, maxsize))
        self.lock = threading.Lock()
        self.pending = []  # final file names whose raw file is not on disk yet
        self.last_error = None
        threading.Thread(target=self._worker, daemon=True, name="raw-writer").start()

    def put(self, image, path, metadata, extra=None, compress=True, upload=None):
        """compress=False keeps the raw TIFF for now (stack frames: focus-stack reads
        TIFF directly and the frames are usually deleted afterwards)."""
        with self.lock:
            self.pending.append(path.name)
        self.queue.put((image, path, metadata, extra, compress, upload))

    def _worker(self):
        while True:
            image, path, metadata, extra, compress, upload = self.queue.get()
            started = time.time()
            try:
                raw = raw_path_for(path)
                save_image(image, raw)
                write_sidecar(path, metadata, extra)
                log.info("raw %s written in %.1fs", raw.name, time.time() - started)
                if raw == path:  # final format is TIFF: nothing left to do
                    if upload:
                        auto_upload(*upload)
                elif compress:
                    compressor.add(raw, path, upload)
            except Exception as exc:
                log.exception("Saving %s failed", path)
                self.last_error = f"{path.name}: {exc}"
            finally:
                with self.lock:
                    self.pending.remove(path.name)
                self.queue.task_done()

    def is_pending(self, name):
        with self.lock:
            return name in self.pending

    def wait_idle(self):
        self.queue.join()

    def status(self):
        with self.lock:
            return {"pending": list(self.pending), "last_error": self.last_error}


class Compressor:
    """Stage 2: convert raw TIFFs to the final format in low-priority threads, one
    per spare CPU core (Pillow releases the GIL while encoding). The work list is
    kept on disk, so a restart or power cut resumes it."""

    def __init__(self, state_file, workers=0):
        self.state_file = state_file
        self.lock = threading.Lock()
        self.wake = threading.Condition(self.lock)
        self.items = []  # {"raw", "final", "upload"}
        self.busy = set()  # raw paths a worker is converting right now
        self.last_error = None
        try:
            self.items = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.items = []
        # Leave one core for the camera, the web UI and the raw writer.
        workers = workers or max(1, (os.cpu_count() or 2) - 1)
        for n in range(workers):
            threading.Thread(target=self._worker, daemon=True, name=f"compressor-{n}").start()

    def _persist(self):
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items), encoding="utf-8")
        os.replace(tmp, self.state_file)

    def add(self, raw, final, upload=None):
        with self.lock:
            if not any(i["raw"] == str(raw) for i in self.items):
                self.items.append({"raw": str(raw), "final": str(final), "upload": upload})
                self._persist()
            self.wake.notify()

    def add_stack(self, stack_dir, name):
        """Queue a stack's raw frames (kept frames, or a stack finished unprocessed)."""
        target = image_ext()
        if target == ".tif":
            return 0
        frames = [f for f in stack_frames(stack_dir, name) if f.suffix.lower() in (".tif", ".tiff")]
        for f in frames:
            self.add(f, f.with_suffix(target))
        return len(frames)

    def _worker(self):
        try:  # background work: yield the CPU to the camera, Flask and focus-stack
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 15)
        except (AttributeError, OSError):
            pass
        from PIL import Image

        while True:
            # focus-stack needs all the RAM it can get (1 GB on a Pi 3B): pause meanwhile.
            while focus_stack_running():
                time.sleep(3)
            with self.lock:
                while not (item := next((i for i in self.items if i["raw"] not in self.busy), None)):
                    self.wake.wait()
                self.busy.add(item["raw"])
            raw, final = Path(item["raw"]), Path(item["final"])
            started = time.time()
            try:
                if stack_busy(final.parent.name):
                    # focus-stack is reading these frames; move to the back, retry later
                    with self.lock:
                        self.items.remove(item)
                        self.items.append(item)
                        self.busy.discard(item["raw"])
                    time.sleep(5)
                    continue
                if raw.exists():
                    with Image.open(raw) as img:
                        img.load()
                        save_image(img, final)
                    raw.unlink()
                    drop_thumb_for(raw)
                    log.info("compressed %s in %.1fs", final.name, time.time() - started)
                    if item.get("upload"):
                        auto_upload(*item["upload"])
            except Exception as exc:
                log.exception("Compressing %s failed", raw)
                self.last_error = f"{final.name}: {exc}"
            with self.lock:
                if item in self.items:
                    self.items.remove(item)
                self.busy.discard(item["raw"])
                self._persist()

    def status(self):
        with self.lock:
            return {"queued": len(self.items), "active": len(self.busy), "last_error": self.last_error}


def focus_stack_running():
    with jobs_lock:
        return any(j["kind"] == "focus-stack" and j["status"] == "running" for j in jobs.values())


def stack_busy(name):
    """A stack that is still being captured or processed must keep its raw frames."""
    if active_stack and active_stack["name"] == name:
        return True
    job = latest_job("focus-stack", name)
    return bool(job and job["status"] in ("queued", "running"))


def drop_thumb_for(path):
    """Remove a cached thumbnail of a file inside photos/ or stacks/."""
    for kind in ("photos", "stacks"):
        try:
            base = data_dir(kind)
            rel = path.resolve().relative_to(base.resolve()).as_posix()
        except (ValueError, StorageUnavailable):
            continue
        drop_thumb(kind, rel)


save_queue = None  # created in main() (queue size comes from the config)
compressor = None


def demo_mode():
    if os.environ.get("MINIATURESTUDIO_DEMO") == "1":
        return True
    try:
        import picamera2  # noqa: F401
    except ImportError:
        return True
    return False


def list_cameras():
    """Cameras libcamera detected at startup (CSI ports are not hot-pluggable)."""
    if demo_mode():
        return [{"index": 0, "model": "demo", "location": None, "id": "demo"}]
    from picamera2 import Picamera2
    return [{"index": i, "model": c.get("Model"), "location": c.get("Location"), "id": c.get("Id"),
             "usb": is_usb_camera(c)}
            for i, c in enumerate(Picamera2.global_camera_info())]


def is_usb_camera(info):
    """UVC webcams sit on a USB path; Raspberry Pi CSI cameras on /base/.../i2c."""
    return "usb" in str(info.get("Id", "")).lower()


def open_camera(index=None, stream=None):
    if demo_mode():
        log.warning("Demo mode (MINIATURESTUDIO_DEMO=1 or picamera2 missing) — no real camera")
        return DemoCamera(stream=stream)
    cameras = list_cameras()
    if not cameras:
        raise RuntimeError("No camera detected — check the ribbon cable and `rpicam-hello --list-cameras`")
    if index is None:
        index = int(CONFIG["camera"].get("index") or 0)
    if index >= len(cameras):
        log.warning("Configured camera %s not present, using camera 0", index)
        index = 0
    log.info("Opening camera %s: %s%s", index, cameras[index]["model"], " (USB)" if cameras[index]["usb"] else "")
    if cameras[index]["usb"]:
        return USBCamera(index, stream=stream)
    return RealCamera(index, stream=stream)


def apply_control_values(cam, values, reset_first=False):
    """Coerce and apply a {control: value} dict; unknown controls are skipped."""
    coerced = {}
    values = effective_controls(values or {}, cam.camera_controls)
    for name, value in values.items():
        if name in cam.camera_controls and name not in HIDDEN_CONTROLS:
            try:
                coerced[name] = coerce_control(name, value, cam.camera_controls[name])
            except (TypeError, ValueError):
                pass
    with camera_lock:
        if reset_first:
            cam.reset_controls()
        try:
            cam.set_controls(coerced)
        except Exception as exc:
            log.warning("Could not apply controls: %s", exc)
    return coerced


def restore_controls(cam):
    """At startup / camera switch: the model's default preset, else its last-used controls."""
    default = CONFIG.get("default_preset", {}).get(cam.model)
    preset = CONFIG.get("presets", {}).get(cam.model, {}).get(default) if default else None
    if preset is not None:
        log.info("Loading default preset %r for %s", default, cam.model)
        apply_control_values(cam, preset)
        return
    if CONFIG.get("persist_controls", True):
        apply_control_values(cam, (CONFIG.get("controls") or {}).get(cam.model))


camera = None  # set in main()
recording = {"active": False, "path": None, "started": None}
active_stack = None  # {"name", "dir", "count"} while collecting frames
state_lock = threading.Lock()


def write_sidecar(path, metadata, extra=None):
    if not CONFIG.get("save_metadata", True):
        return
    data = {"file": path.name, "captured": datetime.now().isoformat(timespec="seconds"),
            "metadata": jsonable(metadata), **(extra or {})}
    path.with_suffix(".json").write_text(json.dumps(data, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------
# Background jobs (focus-stack processing, uploads)
# --------------------------------------------------------------------------

jobs = {}
jobs_lock = threading.Lock()
stack_queue = None  # focus-stack jobs (queue.Queue), worked off by _stack_worker; set in main()
stack_order = []  # ids of focus-stack jobs still waiting, in queue order (guarded by jobs_lock)


def job_log(job, line):
    line = line.rstrip()
    if line:
        job["log"].append(line)
        del job["log"][:-400]


def start_job(kind, name, fn, *args):
    job = {"id": uuid.uuid4().hex[:12], "kind": kind, "name": name, "status": "queued",
           "log": [], "created": time.time(), "finished": None, "result": None, "error": None}
    with jobs_lock:
        jobs[job["id"]] = job

    def runner():
        try:
            if job.get("cancel"):
                raise RuntimeError("cancelled before it started")
            job["status"] = "running"
            job["result"] = fn(job, *args)
            job["status"] = "done"
        except Exception as exc:
            log.exception("Job %s failed", job["id"])
            job["status"] = "error"
            job["error"] = str(exc)
            job_log(job, f"ERROR: {exc}")
        finally:
            job["finished"] = time.time()

    if kind == "focus-stack":
        with jobs_lock:
            stack_order.append(job["id"])
        stack_queue.put((job, runner))  # strictly one after another, in order
    else:
        threading.Thread(target=runner, daemon=True).start()
    return job


def _stack_worker():
    """Runs focus-stack jobs one at a time, first come first served (Pi RAM)."""
    while True:
        job, runner = stack_queue.get()
        with jobs_lock:
            if job["id"] in stack_order:
                stack_order.remove(job["id"])
        if not job.get("cancel"):
            runner()


def stack_queue_position(job_id):
    """1 = next to run; None when not waiting."""
    with jobs_lock:
        return stack_order.index(job_id) + 1 if job_id in stack_order else None


def latest_job(kind, name):
    with jobs_lock:
        matching = [j for j in jobs.values() if j["kind"] == kind and j["name"] == name]
    return max(matching, key=lambda j: j["created"]) if matching else None


# --------------------------------------------------------------------------
# Focus stacking
# --------------------------------------------------------------------------

def find_focus_stack():
    configured = CONFIG["focus_stack"].get("binary")
    for candidate in (configured, str(VENDORED_FOCUS_STACK), shutil.which("focus-stack")):
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


_focus_stack_version = {}


def focus_stack_version(binary):
    if binary not in _focus_stack_version:
        try:
            out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10)
            _focus_stack_version[binary] = (out.stdout or out.stderr).strip()
        except Exception as exc:
            _focus_stack_version[binary] = f"unknown ({exc})"
    return _focus_stack_version[binary]


def stack_frames(stack_dir, name):
    pattern = re.compile(rf"^{re.escape(name)}_(\d+)(\.[A-Za-z]+)$")
    frames = {}
    for f in stack_dir.iterdir():
        m = pattern.match(f.name)
        if m and m.group(2).lower() in IMAGE_EXTS:
            frames.setdefault(int(m.group(1)), f)  # raw + compressed may briefly coexist
    return [frames[n] for n in sorted(frames)]


def stack_outputs(stack_dir, name):
    found = {}
    for f in stack_dir.glob(f"{name}_stacked.*"):
        if f.suffix.lower() in IMAGE_EXTS:
            found["result"] = f.name
    for key in ("depthmap", "3dview"):
        f = stack_dir / f"{name}_{key}.png"
        if f.exists():
            found[key] = f.name
    return found


def build_focus_stack_cmd(binary, stack_dir, name, frames, opts):
    ext = {"jpg": "jpg", "jpeg": "jpg", "tif": "tif", "tiff": "tif"}.get(opts.get("output_format", "png"), "png")
    output = stack_dir / f"{name}_stacked.{ext}"
    # Relative names: focus-stack runs inside the stack folder and truncates long paths in its log.
    cmd = [binary, f"--output={output.name}"]
    if opts.get("depthmap"):
        cmd.append(f"--depthmap={name}_depthmap.png")
    if opts.get("view3d"):
        cmd.append(f"--3dview={name}_3dview.png")
    flags = {
        "global_align": "--global-align",
        "full_resolution_align": "--full-resolution-align",
        "no_whitebalance": "--no-whitebalance",
        "no_contrast": "--no-contrast",
        "no_transform": "--no-transform",
        "no_align": "--no-align",
        "align_keep_size": "--align-keep-size",
        "nocrop": "--nocrop",
        "no_opencl": "--no-opencl",
        "verbose": "--verbose",
    }
    cmd += [flag for key, flag in flags.items() if opts.get(key)]
    values = {
        "consistency": "--consistency", "denoise": "--denoise", "threads": "--threads",
        "batchsize": "--batchsize", "jpgquality": "--jpgquality", "remove_bg": "--remove-bg",
        "reference": "--reference",
    }
    opts = dict(opts)
    if opts.get("threads") in (None, ""):
        opts["threads"] = auto_threads()
    if str(opts.get("batchsize")) == "0":
        opts["batchsize"] = len(frames)  # all frames in one merge batch
    for key, flag in values.items():
        if opts.get(key) not in (None, ""):
            cmd.append(f"{flag}={opts[key]}")
    cmd += shlex.split(opts.get("extra_args") or "")
    cmd += [f.name for f in frames]
    return cmd, output


OOM_EXIT_CODES = (-9, 137)  # SIGKILL: the kernel's out-of-memory killer


def meminfo_mb(key):
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                if line.startswith(key + ":"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 0


def auto_threads():
    """focus-stack holds several full-size float images per thread: scale with RAM, not cores."""
    ram = meminfo_mb("MemTotal") or 4096
    cores = os.cpu_count() or 2
    if ram < 1500:
        return 1  # Pi 3B (1 GB)
    if ram < 3000:
        return min(2, cores)
    return cores


HALOFREE_SCRIPT = BASE_DIR / "scripts" / "halofree-stack.py"
_halofree_check = {}


def halofree_available():
    """The halo-free stacker needs Python OpenCV (python3-opencv on the Pi)."""
    if "ok" not in _halofree_check:
        try:
            probe = subprocess.run([sys.executable, "-c", "import cv2, numpy"], capture_output=True, timeout=60)
            _halofree_check["ok"] = probe.returncode == 0 and HALOFREE_SCRIPT.exists()
        except Exception:
            _halofree_check["ok"] = False
    return _halofree_check["ok"]


def stack_method(opts):
    """(method, focus-stack binary) a job will use; falls back when a tool is missing."""
    wanted = opts.get("method") or "halofree"
    binary = find_focus_stack()
    if wanted == "halofree" and halofree_available():
        return "halofree", binary
    if binary:
        return "focus-stack", binary
    if halofree_available():
        return "halofree", None
    return None, None


def build_halofree_cmd(stack_dir, name, frames, opts):
    ext = {"jpg": "jpg", "jpeg": "jpg", "tif": "tif", "tiff": "tif"}.get(opts.get("output_format", "png"), "png")
    output = stack_dir / f"{name}_stacked.{ext}"
    cmd = [sys.executable, str(HALOFREE_SCRIPT), f"--output={output.name}",
           f"--pngcompression={CONFIG.get('png_compress_level', 3)}"]
    if opts.get("depthmap"):
        cmd.append(f"--depthmap={name}_depthmap.png")
    for key, flag in (("halofree_threshold", "--threshold"), ("halofree_band", "--halo-band"),
                      ("reference", "--reference"), ("jpgquality", "--jpgquality")):
        if opts.get(key) not in (None, ""):
            cmd.append(f"{flag}={opts[key]}")
    cmd += [f.name for f in frames]
    return cmd, output


def run_focus_stack_once(job, binary, stack_dir, name, frames, opts):
    cmd, output = build_focus_stack_cmd(binary, stack_dir, name, frames, opts)
    return run_stacker(job, cmd, stack_dir), output


def run_stacker(job, cmd, stack_dir):
    job_log(job, "$ " + " ".join(shlex.quote(c) for c in cmd))
    # Low priority: the camera and web UI stay responsive while stacks are processed.
    nice = (lambda: os.nice(10)) if os.name == "posix" else None
    proc = subprocess.Popen(cmd, cwd=stack_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, preexec_fn=nice)
    job["pid"] = proc.pid
    for line in proc.stdout:
        job_log(job, line)
    return proc.wait()


def run_focus_stack(job, name, overrides):
    stack_dir = safe_child(data_dir("stacks"), name)
    waiting = len(save_queue.status()["pending"])
    if waiting:
        job_log(job, f"Waiting for {waiting} frame(s) to be written…")
    save_queue.wait_idle()
    frames = stack_frames(stack_dir, name)
    if len(frames) < 2:
        raise RuntimeError(f"Need at least 2 frames, found {len(frames)}")
    opts = {**CONFIG["focus_stack"], **(overrides or {})}
    method, binary = stack_method(opts)
    if not method:
        raise RuntimeError("no stacker available — run ./install.sh (builds focus-stack, installs python3-opencv)")
    if method != (opts.get("method") or "halofree"):
        job_log(job, f"{opts.get('method')} is not available — using {method} instead")
    for old in stack_dir.glob(f"{name}_stacked.*"):
        old.unlink()
    started = time.time()
    if method == "halofree":
        job_log(job, "Method: halo-free (black backdrop)")
        cmd, output = build_halofree_cmd(stack_dir, name, frames, opts)
        rc = run_stacker(job, cmd, stack_dir)
    else:
        job_log(job, "Method: focus-stack")
        rc, output = run_focus_stack_once(job, binary, stack_dir, name, frames, opts)
    if method == "focus-stack" and rc in OOM_EXIT_CODES and not job.get("cancel"):
        # Killed by the kernel's out-of-memory killer: retry once as lean as possible.
        job_log(job, "focus-stack ran out of memory — retrying with threads=1, batchsize=2 (slower)")
        rc, output = run_focus_stack_once(job, binary, stack_dir, name, frames,
                                          {**opts, "threads": 1, "batchsize": 2})
    (stack_dir / "process.log").write_text("\n".join(job["log"]), encoding="utf-8")
    if rc in OOM_EXIT_CODES:
        raise RuntimeError(f"{method} ran out of memory ({meminfo_mb('MemTotal')} MB RAM, "
                           f"{meminfo_mb('SwapTotal')} MB swap) — enlarge the swap (see README) "
                           "or use fewer frames")
    if rc != 0:
        raise RuntimeError(f"{method} exited with code {rc}")
    if not output.exists():
        raise RuntimeError(f"{method} finished but produced no output file")
    job_log(job, f"Done in {time.time() - started:.0f}s -> {output.name}")
    result = {"output": output.name, "seconds": round(time.time() - started, 1)}
    if opts.get("delete_frames"):
        dests = auto_upload_dests()
        if dests and CONFIG["upload"].get("stack_frames"):
            # Frames are about to disappear: upload them now, inside this job.
            for dest in dests:
                run_upload(job, dest, "stack", name)
            result["deleted_frames"] = delete_stack_frames(stack_dir, name)
            job_log(job, f"Deleted {result['deleted_frames']} source frames")
            return result
        result["deleted_frames"] = delete_stack_frames(stack_dir, name)
        job_log(job, f"Deleted {result['deleted_frames']} source frames")
    else:
        queued = compressor.add_stack(stack_dir, name)
        if queued:
            job_log(job, f"Queued {queued} kept frames for compression")
    result["uploads"] = auto_upload("stack", name)
    return result


def delete_stack_frames(stack_dir, name):
    frames = stack_frames(stack_dir, name)
    for f in frames:
        f.unlink()
        f.with_suffix(".json").unlink(missing_ok=True)
        drop_thumb("stacks", f"{name}/{f.name}")
    return len(frames)


# --------------------------------------------------------------------------
# Uploads (always explicit)
# --------------------------------------------------------------------------

def upload_sources(kind, name):
    if kind == "photo":
        path = safe_child(data_dir("photos"), name)
        sidecar = path.with_suffix(".json")
        return [path] + ([sidecar] if sidecar.exists() else []), "photos"
    if kind == "video":
        return [safe_child(data_dir("videos"), name)], "videos"
    if kind == "stack":
        stack_dir = safe_child(data_dir("stacks"), name)
        if CONFIG["upload"].get("stack_frames", False):
            return [stack_dir], "stacks"
        outputs = stack_outputs(stack_dir, name)
        if not outputs:
            raise RuntimeError("Stack has no processed result yet (enable 'upload stack frames' to send frames)")
        files = [stack_dir / f for f in outputs.values()]
        return files, f"stacks/{name}"
    raise RuntimeError(f"Unknown kind {kind!r}")


def mount_point(path):
    path = path.resolve()
    while not os.path.ismount(path):
        path = path.parent
    return path


def run_upload(job, dest, kind, name):
    sources, subdir = upload_sources(kind, name)
    up = CONFIG["upload"]
    if dest == "drive":
        rclone = shutil.which("rclone")
        if not rclone:
            raise RuntimeError("rclone not installed")
        remote = up["rclone_remote"].rstrip("/")
        for src in sources:
            target = f"{remote}/{subdir}/{src.name}" if src.is_dir() else f"{remote}/{subdir}"
            cmd = [rclone, "copy", str(src), target, "--stats-one-line", "-v"]
            job_log(job, "$ " + " ".join(cmd))
            proc = subprocess.run(cmd, capture_output=True, text=True)
            for line in (proc.stdout + proc.stderr).splitlines():
                job_log(job, line)
            if proc.returncode != 0:
                raise RuntimeError(f"rclone exited with code {proc.returncode}")
        return {"dest": remote}
    if dest == "nas":
        nas = Path(up["nas_path"])
        if not nas.is_dir():
            raise RuntimeError(f"NAS path {nas} does not exist — is the share mounted?")
        if up.get("nas_require_mount", True) and mount_point(nas) == Path("/"):
            raise RuntimeError(f"{nas} is not on a mounted share (would write to the SD card)")
        target_dir = nas / subdir
        target_dir.mkdir(parents=True, exist_ok=True)
        for src in sources:
            job_log(job, f"copy {src} -> {target_dir}")
            if src.is_dir():
                shutil.copytree(src, target_dir / src.name, dirs_exist_ok=True)
            else:
                shutil.copy2(src, target_dir / src.name)
        return {"dest": str(target_dir)}
    raise RuntimeError(f"Unknown destination {dest!r}")


_drive_check = {"at": 0.0, "ok": False}


def drive_available():
    """True when rclone is installed and the configured remote exists (cached 60s)."""
    if time.time() - _drive_check["at"] < 60:
        return _drive_check["ok"]
    ok = False
    rclone = shutil.which("rclone")
    remote = CONFIG["upload"].get("rclone_remote", "").split(":")[0]
    if rclone and remote:
        try:
            out = subprocess.run([rclone, "listremotes"], capture_output=True, text=True, timeout=15)
            ok = f"{remote}:" in out.stdout.split()
        except Exception as exc:
            log.warning("rclone listremotes failed: %s", exc)
    _drive_check.update(at=time.time(), ok=ok)
    return ok


def nas_available():
    nas = Path(CONFIG["upload"].get("nas_path") or "/nonexistent")
    if not nas.is_dir():
        return False
    return not CONFIG["upload"].get("nas_require_mount", True) or mount_point(nas) != Path("/")


def auto_upload_dests():
    up = CONFIG["upload"]
    dests = []
    if up.get("auto_drive") and drive_available():
        dests.append("drive")
    if up.get("auto_nas") and nas_available():
        dests.append("nas")
    return dests


def auto_upload(kind, name):
    """Queue uploads for the destinations that have auto-upload enabled and are reachable."""
    return [start_job("upload", f"{kind}:{name}", run_upload, dest, kind, name)["id"]
            for dest in auto_upload_dests()]


# --------------------------------------------------------------------------
# LensPosition sweep (AF cameras only)
# --------------------------------------------------------------------------

def sweep_positions(start, end, steps):
    steps = max(2, int(steps))
    return [round(start + (end - start) * i / (steps - 1), 4) for i in range(steps)]


# Values that hand a control back to the automatic algorithms (Raspberry Pi libcamera:
# ExposureTime / AnalogueGain 0 = auto). ColourGains has no "auto" value: AwbEnable does it.
AUTO_VALUES = {"AeEnable": True, "AwbEnable": True, "ExposureTime": 0, "AnalogueGain": 0,
               "ExposureTimeMode": 0, "AnalogueGainMode": 0}


def exposure_lock_controls():
    """Controls that freeze the current auto exposure / white balance; {} if already manual."""
    cc, applied = camera.camera_controls, camera.applied
    with camera_lock:
        md = camera.metadata()
    lock = {}
    auto_exposure = applied.get("AeEnable", True) is not False and applied.get("ExposureTimeMode", 0) != 1
    if auto_exposure and md.get("ExposureTime"):
        for name in ("ExposureTime", "AnalogueGain"):
            if name in cc and md.get(name) is not None:
                lock[name] = md[name]
        if "ExposureTimeMode" in cc:  # newer libcamera
            lock["ExposureTimeMode"] = 1
            if "AnalogueGainMode" in cc:
                lock["AnalogueGainMode"] = 1
        elif "AeEnable" in cc:
            lock["AeEnable"] = False
    if applied.get("AwbEnable", True) is not False and md.get("ColourGains") and "ColourGains" in cc:
        lock["ColourGains"] = tuple(md["ColourGains"])
        if "AwbEnable" in cc:
            lock["AwbEnable"] = False
    return {k: coerce_control(k, v, cc[k]) for k, v in lock.items()}


def lock_exposure_for_stack():
    """Frames of one stack must match in brightness and colour, or focus-stack leaves halos."""
    if not CONFIG["camera"].get("lock_exposure_in_stacks", True):
        return None
    lock = exposure_lock_controls()
    if not lock:
        return None
    before = {k: camera.applied[k] for k in lock if k in camera.applied}
    with camera_lock:
        camera.set_controls(lock)
    log.info("Stack: exposure/white balance locked at %s", jsonable(lock))
    return {"locked": list(lock), "before": before}


def unlock_exposure(state):
    if not state:
        return
    restore = {}
    for name in state["locked"]:
        if name in state["before"]:
            restore[name] = state["before"][name]
        elif name in AUTO_VALUES:
            restore[name] = AUTO_VALUES[name]
    with camera_lock:
        try:
            camera.set_controls(restore)
        except Exception as exc:
            log.warning("Restoring auto exposure failed: %s", exc)
        for name in state["locked"]:
            if name not in state["before"]:
                camera.applied.pop(name, None)  # was automatic: do not keep or persist it


def run_sweep(job, name, positions, settle_ms, process):
    """Capture one stack frame per lens position, then optionally process it."""
    global active_stack
    stack_dir = data_dir("stacks") / name
    try:
        with camera_lock:
            camera.set_controls({"AfMode": 0})
        for n, pos in enumerate(positions, start=1):
            if job.get("cancel"):
                job_log(job, "Cancelled")
                break
            with camera_lock:
                camera.set_controls({"LensPosition": float(pos)})
                time.sleep(settle_ms / 1000)
                path = stack_dir / f"{name}_{n}{image_ext()}"
                image, metadata = camera.grab()
            image, box = apply_crop(image)
            save_queue.put(image, path, metadata, {"stack": name, "frame": n, "lens_position_target": pos,
                                                   "crop": box}, compress=False)
            with state_lock:
                active_stack["count"] = n
            job_log(job, f"frame {n}/{len(positions)} @ LensPosition {pos} "
                         f"(reported {jsonable(metadata.get('LensPosition'))})")
    finally:
        with state_lock:
            count = active_stack["count"] if active_stack else 0
            exposure_state = active_stack.get("exposure_lock") if active_stack else None
            active_stack = None
        unlock_exposure(exposure_state)
    result = {"frames": count}
    if process and count >= 2 and not job.get("cancel"):
        result["process_job"] = start_job("focus-stack", name, run_focus_stack, name, None)["id"]
    return result


# --------------------------------------------------------------------------
# Routes — pages, preview, media
# --------------------------------------------------------------------------

@app.route("/")
def index():
    # Cache-busting: a changed file gets a new ?v=, so browsers load it right after an update.
    static = BASE_DIR / "static"
    asset_v = int(max((f.stat().st_mtime for f in static.iterdir() if f.is_file()), default=0))
    return render_template("index.html", asset_v=asset_v)


@app.route("/stream.mjpg")
def stream():
    output = camera.stream

    def frames():
        while True:
            with output.condition:
                output.condition.wait(timeout=5)
                frame = output.frame
            if frame is None:
                continue
            yield (b"--FRAME\r\nContent-Type: image/jpeg\r\nContent-Length: "
                   + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")

    return Response(frames(), mimetype="multipart/x-mixed-replace; boundary=FRAME",
                    headers={"Cache-Control": "no-cache, private", "Pragma": "no-cache"})


MEDIA_KINDS = {"photos": "photos", "stacks": "stacks", "videos": "videos"}


@app.route("/media/<kind>/<path:relpath>")
def media(kind, relpath):
    if kind not in MEDIA_KINDS:
        abort(404)
    path = safe_child(data_dir(kind), relpath)
    if not path.is_file():
        abort(404)
    if request.args.get("as") == "png" and path.suffix.lower() in (".tif", ".tiff"):
        # Compress on download (TIFF storage mode). Takes ~10-15 s on a Pi 3B.
        from PIL import Image

        buf = io.BytesIO()
        with Image.open(path) as img:
            img.save(buf, "PNG", compress_level=int(CONFIG.get("png_compress_level", 3)))
        buf.seek(0)
        return send_file(buf, mimetype="image/png", as_attachment=True,
                         download_name=path.with_suffix(".png").name)
    return send_file(path, as_attachment=request.args.get("download") == "1")


@app.route("/download/stack/<name>.zip")
def download_stack(name):
    """Whole stack folder as a zip (stored, PNGs are already compressed)."""
    import tempfile
    import zipfile

    stack_dir = safe_child(data_dir("stacks"), name)
    # On disk next to the data, not /tmp (tmpfs = RAM on newer Pi OS).
    tmp_dir = data_dir("stacks") / ".tmp"
    tmp_dir.mkdir(exist_ok=True)
    for stale in tmp_dir.glob("stack_*.zip"):
        if time.time() - stale.stat().st_mtime > 3600:
            try:
                stale.unlink()
            except OSError:
                pass
    tmp = tempfile.NamedTemporaryFile(prefix="stack_", suffix=".zip", delete=False, dir=tmp_dir)
    tmp.close()
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_STORED) as zf:
        for f in sorted(stack_dir.iterdir()):
            if f.is_file():
                zf.write(f, f"{name}/{f.name}")
    response = send_file(tmp.name, as_attachment=True, download_name=f"{name}.zip")
    def cleanup():
        try:
            os.unlink(tmp.name)
        except OSError:
            pass  # still open (Windows); removed by the stale sweep above

    response.call_on_close(cleanup)
    return response


@app.route("/thumb/<kind>/<path:relpath>")
def thumb(kind, relpath):
    if kind not in MEDIA_KINDS:
        abort(404)
    base = data_dir(kind)
    src = safe_child(base, relpath)
    if src.suffix.lower() not in IMAGE_EXTS:
        abort(404)
    # size=large: a screen-sized JPEG for the viewer (browsers cannot show TIFF).
    large = request.args.get("size") == "large"
    box = (2048, 1536) if large else (480, 360)
    cache = base / ".thumbs" / (relpath.replace("/", "__") + (".large.jpg" if large else ".jpg"))
    if not cache.exists() or cache.stat().st_mtime < src.stat().st_mtime:
        from PIL import Image
        cache.parent.mkdir(exist_ok=True)
        with Image.open(src) as img:
            img.draft("RGB", box)
            img = img.convert("RGB")
            img.thumbnail(box)
            img.save(cache, "JPEG", quality=88 if large else 80)
    return send_file(cache, max_age=3600)


# --------------------------------------------------------------------------
# Routes — camera
# --------------------------------------------------------------------------

LIVE_METADATA_KEYS = ("ExposureTime", "AnalogueGain", "DigitalGain", "ColourTemperature",
                      "ColourGains", "Lux", "LensPosition", "AfState", "FocusFoM", "FrameDuration")


@app.route("/api/controls", methods=["GET", "POST"])
def api_controls():
    if request.method == "GET":
        with camera_lock:
            try:
                metadata = camera.metadata()
            except Exception as exc:
                log.warning("capture_metadata failed: %s", exc)
                metadata = {}
        current = {**metadata, **camera.applied}
        live = {k: jsonable(metadata[k]) for k in LIVE_METADATA_KEYS if k in metadata}
        return jsonify(controls=describe_controls(camera.camera_controls, current), live=live)

    body = request.get_json(force=True) or {}
    if body.get("reset"):
        with camera_lock:
            camera.reset_controls()
        CONFIG.setdefault("controls", {}).pop(camera.model, None)
        save_config()
        return jsonify(ok=True, applied={})

    errors, to_set = {}, {}
    for name, value in body.items():
        info = camera.camera_controls.get(name)
        if info is None or name in HIDDEN_CONTROLS:
            errors[name] = "unknown control"
            continue
        try:
            to_set[name] = coerce_control(name, value, info)
        except (TypeError, ValueError) as exc:
            errors[name] = str(exc)
    switched = []
    if to_set:
        cc = camera.camera_controls
        new_libcamera = "ExposureTimeMode" in cc
        # Setting a manual value means "manual": switch the matching mode, like a real camera.
        if "ExposureTime" in to_set and not ({"ExposureTimeMode", "AeEnable"} & set(body)):
            key, value = ("ExposureTimeMode", 1) if new_libcamera else ("AeEnable", False)
            if key in cc and camera.applied.get(key) != value:
                to_set[key] = value
                switched.append(key)
        if "AnalogueGain" in to_set and not ({"AnalogueGainMode", "AeEnable"} & set(body)):
            key, value = ("AnalogueGainMode", 1) if "AnalogueGainMode" in cc else ("AeEnable", False)
            if key in cc and camera.applied.get(key) != value:
                to_set[key] = value
                switched.append(key)
        if ({"ColourGains", "ColourTemperature"} & set(to_set)) and "AwbEnable" not in body \
                and "AwbEnable" in cc and camera.applied.get("AwbEnable") is not False:
            to_set["AwbEnable"] = False
            switched.append("AwbEnable")
        with camera_lock:
            try:
                camera.set_controls(to_set)
            except Exception as exc:
                return jsonify(ok=False, errors={"_": str(exc)}), 400
        # Back to automatic: forget the manual values, so they cannot interfere later.
        cc = camera.camera_controls
        for name in [n for n in ("ExposureTime", "AnalogueGain", "ColourGains", "ColourTemperature")
                     if n in camera.applied]:
            if name not in effective_controls(camera.applied, cc):
                camera.applied.pop(name)
        if CONFIG.get("persist_controls", True):
            CONFIG.setdefault("controls", {})[camera.model] = jsonable(camera.applied)
            save_config()
    return jsonify(ok=not errors, applied=jsonable(camera.applied), errors=errors, switched=switched)


@app.route("/api/controls/lock_exposure", methods=["POST"])
def api_lock_exposure():
    """One click: keep the current auto exposure and white balance as manual values."""
    lock = exposure_lock_controls()
    if lock:
        with camera_lock:
            camera.set_controls(lock)
        if CONFIG.get("persist_controls", True):
            CONFIG.setdefault("controls", {})[camera.model] = jsonable(camera.applied)
            save_config()
    return jsonify(ok=True, locked=jsonable(lock))


@app.route("/api/camera_info")
def api_camera_info():
    method, binary = stack_method(CONFIG["focus_stack"])
    return jsonify(
        model=camera.model,
        index=camera.index,
        camera_error=getattr(camera, "error", None),
        has_autofocus=camera.has_autofocus,
        demo=camera.demo,
        sensor_resolution=list(camera.sensor_resolution),
        sensor_modes=getattr(camera, "sensor_modes", []),
        usb=isinstance(camera, USBCamera),
        still_size=CONFIG["camera"].get("still_size"),
        focus_stack={"available": bool(method), "method": method, "binary": binary,
                     "halofree": halofree_available(),
                     "version": focus_stack_version(binary) if binary else None},
        lens_range=jsonable(camera.camera_controls.get("LensPosition")),
        drive=drive_available(),
        nas=nas_available(),
        ffmpeg=bool(shutil.which("ffmpeg")),
    )


@app.route("/api/cameras", methods=["GET", "POST"])
def api_cameras():
    """List detected cameras; POST {"index": n} switches to another one."""
    global camera
    if request.method == "POST":
        index = int((request.get_json(force=True) or {}).get("index", 0))
        with state_lock:
            if recording["active"] or active_stack:
                return jsonify(ok=False, error="stop recording / finish the stack first"), 409
        if index >= len(list_cameras()):
            return jsonify(ok=False, error=f"no camera {index}"), 400
        with camera_lock:
            stream = camera.stream
            camera.close()
            try:
                camera = open_camera(index, stream=stream)
            except Exception as exc:
                log.exception("Switching camera failed, reopening previous")
                try:
                    camera = open_camera(stream=stream)
                except Exception as exc2:
                    camera = NoCamera(exc2, stream=stream)
                return jsonify(ok=False, error=str(exc)), 500
        restore_controls(camera)
    return jsonify(ok=True, cameras=list_cameras(), active=camera.index, model=camera.model,
                   default=int(CONFIG["camera"].get("index") or 0))


CAMERA_LINE = re.compile(r"camera_auto_detect|dtoverlay=(imx|ov|arducam)|miniaturestudio-camera", re.I)
KERNEL_CAMERA = re.compile(r"imx\d|ov\d|arducam|unicam|camera|cam[01]|i2c.*(fail|error)", re.I)


@app.route("/api/camera/diagnostics")
def api_camera_diagnostics():
    return jsonify(ok=True, **camera_diagnostics())


def camera_diagnostics():
    """Everything needed to tell why a camera is not found, without SSH: the cameras
    libcamera sees, the camera lines in config.txt and the kernel's camera messages."""
    report = {}
    try:
        out = subprocess.run(["rpicam-hello", "--list-cameras"], capture_output=True, text=True, timeout=30)
        report["list_cameras"] = (out.stdout + out.stderr).strip() or "(no output)"
    except FileNotFoundError:
        report["list_cameras"] = "rpicam-hello is not installed"
    except Exception as exc:
        report["list_cameras"] = f"failed: {exc}"
    config_path = next((c for c in ("/boot/firmware/config.txt", "/boot/config.txt") if os.path.exists(c)), None)
    lines = []
    if config_path:
        try:
            lines = [l for l in Path(config_path).read_text(encoding="utf-8", errors="replace").splitlines()
                     if CAMERA_LINE.search(l)]
        except OSError as exc:
            lines = [f"cannot read: {exc}"]
    report["config"] = {"path": config_path, "lines": lines}
    kernel = read_journal(3000, kernel=True) or []
    report["kernel"] = [l for l in kernel if KERNEL_CAMERA.search(l)][-40:] or ["(no camera messages, or kernel log not readable)"]

    # Plain-language verdict
    listed = report["list_cameras"]
    detected = bool(re.search(r"^\s*\d+\s*:", listed, re.M))
    overlay = [l for l in lines if l.strip().startswith("dtoverlay=") and not l.strip().startswith("#")]
    auto_off = any(l.strip().startswith("camera_auto_detect=0") for l in lines)
    errors = [l for l in report["kernel"] if re.search(r"fail|error|timed out|not found|-\d+", l, re.I)]
    if detected:
        verdict = "The Pi detects a camera (see the list). If the app still shows no camera, press System → Restart app."
    elif not overlay and not auto_off:
        verdict = ("No camera detected, and no sensor is set. Official Raspberry Pi cameras are found automatically; "
                   "third-party sensors such as the Arducam IMX519 need Camera sensor setup → pick the sensor → "
                   "Apply & reboot. If it is an official camera: check the ribbon cable with the Pi switched off.")
    elif overlay and errors:
        verdict = ("A sensor is set (" + ", ".join(o.split("=", 1)[1] for o in overlay) + "), but the kernel reports "
                   "errors talking to it (see below). Usually the ribbon cable: reseat both ends with the Pi switched "
                   "off, contacts the right way round (Arducam boards often face the other way than the HQ camera), "
                   "latch fully closed. Also check that the chosen sensor matches the camera.")
    elif overlay:
        verdict = ("A sensor is set (" + ", ".join(o.split("=", 1)[1] for o in overlay) + "), but no camera is "
                   "detected. Reboot if you just changed the setting; otherwise check the ribbon cable and that "
                   "the chosen sensor matches the camera.")
    else:
        verdict = "No camera detected. Check the ribbon cable with the Pi switched off, then reboot."
    report["verdict"] = verdict
    return report


@app.route("/api/camera/sensor", methods=["GET", "POST"])
def api_camera_sensor():
    """Third-party CSI sensors (Arducam 16/64MP) need a dtoverlay in config.txt + reboot."""
    try:
        if request.method == "POST":
            body = request.get_json(force=True) or {}
            result = run_mount_helper("camera-set", {"sensor": body.get("sensor", "auto"),
                                                     "port": body.get("port", "")})
        else:
            result = run_mount_helper("camera-status")
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, **result)


@app.route("/api/cameras/default", methods=["POST"])
def api_cameras_default():
    """The camera opened at boot."""
    index = int((request.get_json(force=True) or {}).get("index", 0))
    if index >= len(list_cameras()):
        return jsonify(ok=False, error=f"no camera {index}"), 400
    CONFIG["camera"]["index"] = index
    save_config()
    return jsonify(ok=True, default=index)


# Presets: named sets of camera controls, stored per camera model.

def model_presets():
    return CONFIG.setdefault("presets", {}).setdefault(camera.model, {})


@app.route("/api/presets")
def api_presets():
    return jsonify(ok=True, model=camera.model, presets=sorted(model_presets()),
                   default=CONFIG.get("default_preset", {}).get(camera.model))


@app.route("/api/presets", methods=["POST"])
def api_preset_save():
    name = sanitize((request.get_json(force=True) or {}).get("name", ""))
    if not name:
        return jsonify(ok=False, error="preset name required"), 400
    model_presets()[name] = jsonable(camera.applied)
    save_config()
    return jsonify(ok=True, name=name, controls=model_presets()[name])


@app.route("/api/presets/<name>/load", methods=["POST"])
def api_preset_load(name):
    preset = model_presets().get(name)
    if preset is None:
        abort(404)
    # Reset first, so controls not in the preset go back to their defaults.
    apply_control_values(camera, preset, reset_first=True)
    if CONFIG.get("persist_controls", True):
        CONFIG.setdefault("controls", {})[camera.model] = jsonable(camera.applied)
        save_config()
    return jsonify(ok=True, applied=jsonable(camera.applied))


@app.route("/api/presets/<name>", methods=["DELETE"])
def api_preset_delete(name):
    if model_presets().pop(name, None) is None:
        abort(404)
    defaults = CONFIG.setdefault("default_preset", {})
    if defaults.get(camera.model) == name:
        defaults.pop(camera.model)
    save_config()
    return jsonify(ok=True)


@app.route("/api/presets/default", methods=["POST"])
def api_preset_default():
    """Preset loaded at every boot for the current camera model; null clears it."""
    name = (request.get_json(force=True) or {}).get("name")
    defaults = CONFIG.setdefault("default_preset", {})
    if name is None:
        defaults.pop(camera.model, None)
    elif name not in model_presets():
        return jsonify(ok=False, error=f"unknown preset {name!r}"), 404
    else:
        defaults[camera.model] = name
    save_config()
    return jsonify(ok=True, default=defaults.get(camera.model))


@app.route("/api/status")
def api_status():
    with state_lock:
        stack = ({**active_stack, "dir": None, "exposure_lock": bool(active_stack.get("exposure_lock"))}
                 if active_stack else None)
        rec = dict(recording, path=recording["path"] and Path(recording["path"]).name)
    return jsonify(recording=rec, stack=stack, next_seq=CONFIG.get("next_seq", 1),
                   saving=save_queue.status(), compressing=compressor.status(),
                   storage={"target": storage_target(),
                            "available": storage_target() != "usb" or os.path.ismount(USB_MOUNT),
                            "label": CONFIG.get("storage", {}).get("label")},
                   preview_mode=getattr(camera, "mode", None),
                   preview_stalled_s=camera.stream.seconds_without_frames())


@app.route("/api/autofocus/trigger", methods=["POST"])
def api_autofocus():
    if not camera.has_autofocus:
        return jsonify(ok=False, error="camera has no autofocus"), 400
    with camera_lock:
        ok, lens = camera.autofocus()
    return jsonify(ok=bool(ok), lens_position=lens)


def laplacian_variance(gray):
    lap = (gray[1:-1, :-2] + gray[1:-1, 2:] + gray[:-2, 1:-1] + gray[2:, 1:-1]
           - 4 * gray[1:-1, 1:-1])
    return float(lap.var())


@app.route("/api/focus_check")
def api_focus_check():
    """100% crop of the full-resolution stream plus a sharpness score."""
    import numpy as np
    from PIL import Image

    if recording["active"]:
        return jsonify(error="not available while recording"), 409
    x = min(max(float(request.args.get("x", 0.5)), 0.0), 1.0)
    y = min(max(float(request.args.get("y", 0.5)), 0.0), 1.0)
    size = int(request.args.get("size", 600))
    focus_hold["last"] = time.time()
    with camera_lock:
        if camera.mode == "preview":
            camera.set_hold_full(True)  # real 100% crops need the full sensor mode
        if hasattr(camera, "capture_crop"):
            crop = camera.capture_crop(x, y, size, int(size * 0.75))
        else:
            frame = camera.capture_main_array()
            h, w = frame.shape[:2]
            cw, ch = min(size, w), min(int(size * 0.75), h)
            left = int(min(max(x * w - cw / 2, 0), w - cw))
            top = int(min(max(y * h - ch / 2, 0), h - ch))
            crop = frame[top:top + ch, left:left + cw, :3]
    if camera.bgr_arrays:
        crop = crop[:, :, ::-1]  # picamera2 "RGB888" arrays are BGR ordered
    score = laplacian_variance(crop.astype(np.float32).mean(axis=2))
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(crop)).save(buf, "JPEG", quality=90)
    return Response(buf.getvalue(), mimetype="image/jpeg",
                    headers={"X-Sharpness": f"{score:.1f}", "Cache-Control": "no-store"})


focus_hold = {"last": 0.0}
FOCUS_HOLD_SECONDS = 20


@app.route("/api/focus_check/stop", methods=["POST"])
def api_focus_check_stop():
    """Back to the fast binned preview (also happens automatically after 20 s)."""
    focus_hold["last"] = 0.0
    release_focus_hold()
    return jsonify(ok=True)


def release_focus_hold():
    if camera.hold_full and not recording["active"]:
        with camera_lock:
            camera.set_hold_full(False)


def focus_hold_watchdog():
    while True:
        time.sleep(5)
        if camera and camera.hold_full and time.time() - focus_hold["last"] > FOCUS_HOLD_SECONDS:
            try:
                release_focus_hold()
            except Exception:
                log.exception("Leaving full-res focus mode failed")


@app.route("/api/capture", methods=["POST"])
def api_capture():
    if recording["active"]:
        return jsonify(ok=False, error="recording in progress"), 409
    label = (request.get_json(silent=True) or {}).get("label", "")
    directory, ext = data_dir("photos"), image_ext()
    stem = unique_stem(directory, build_basename(label), ext)
    path = directory / f"{stem}{ext}"
    started = time.time()
    with camera_lock:
        image, metadata = camera.grab()
    grabbed = time.time() - started
    image, box = apply_crop(image)
    # Encoding + upload run in the background; auto-upload starts once the file exists.
    save_queue.put(image, path, metadata, {"label": label, "crop": box}, upload=("photo", path.name))
    log.info("photo %s: grab %.1fs, queued after %.1fs", path.name, grabbed, time.time() - started)
    return jsonify(ok=True, file=path.name, seconds=round(grabbed, 2), saving=True,
                   uploads=["queued"] if auto_upload_dests() else [])


@app.route("/api/video/start", methods=["POST"])
def api_video_start():
    label = (request.get_json(silent=True) or {}).get("label", "")
    with state_lock:
        if recording["active"]:
            return jsonify(ok=False, error="already recording"), 409
        if active_stack:
            return jsonify(ok=False, error="finish the stack first"), 409
        recording["active"] = True
    directory = data_dir("videos")
    stem = unique_stem(directory, build_basename(label), ".mp4")
    try:
        with camera_lock:
            path = camera.start_video(stem, directory)
    except Exception as exc:
        log.exception("Starting video failed")
        with camera_lock:
            try:
                camera.stop_video()
            except Exception:
                log.exception("Restoring still mode failed")
        recording["active"] = False
        return jsonify(ok=False, error=str(exc)), 500
    recording.update(path=str(path), started=time.time())
    return jsonify(ok=True, file=path.name)


@app.route("/api/video/stop", methods=["POST"])
def api_video_stop():
    if not recording["active"]:
        return jsonify(ok=False, error="not recording"), 409
    with camera_lock:
        camera.stop_video()
    path = Path(recording["path"]) if recording["path"] else None
    duration = time.time() - (recording["started"] or time.time())
    recording.update(active=False, path=None, started=None)
    uploads = auto_upload("video", path.name) if path and path.exists() and not camera.demo else []
    return jsonify(ok=True, file=path.name if path else None, seconds=round(duration, 1), uploads=uploads)


# --------------------------------------------------------------------------
# Routes — focus stacks
# --------------------------------------------------------------------------

@app.route("/api/stack/start", methods=["POST"])
def api_stack_start():
    global active_stack
    label = (request.get_json(silent=True) or {}).get("label", "")
    with state_lock:
        if active_stack:
            return jsonify(ok=False, error=f"stack {active_stack['name']} still open"), 409
        if recording["active"]:
            return jsonify(ok=False, error="recording in progress"), 409
        base = data_dir("stacks")
        name = unique_stem(base, build_basename(label), "")
        stack_dir = base / name
        stack_dir.mkdir()
        meta = {"name": name, "label": label, "created": datetime.now().isoformat(timespec="seconds")}
        (stack_dir / "stack.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        active_stack = {"name": name, "dir": str(stack_dir), "count": 0}
    active_stack["exposure_lock"] = lock_exposure_for_stack()
    return jsonify(ok=True, name=name, exposure_locked=bool(active_stack["exposure_lock"]))


@app.route("/api/stack/frame", methods=["POST"])
def api_stack_frame():
    with state_lock:
        if not active_stack:
            return jsonify(ok=False, error="no stack open"), 409
        if active_stack.get("sweep"):
            return jsonify(ok=False, error="a lens sweep is running"), 409
        active_stack["count"] += 1
        n, name, stack_dir = active_stack["count"], active_stack["name"], Path(active_stack["dir"])
    path = stack_dir / f"{name}_{n}{image_ext()}"
    started = time.time()
    try:
        with camera_lock:
            image, metadata = camera.grab()
    except Exception:
        with state_lock:
            active_stack["count"] -= 1
        raise
    grabbed = time.time() - started
    image, box = apply_crop(image)
    save_queue.put(image, path, metadata, {"stack": name, "frame": n, "crop": box}, compress=False)
    return jsonify(ok=True, name=name, frame=n, file=path.name, seconds=round(grabbed, 2), saving=True)


@app.route("/api/stack/end", methods=["POST"])
def api_stack_end():
    global active_stack
    with state_lock:
        if not active_stack:
            return jsonify(ok=False, error="no stack open"), 409
        if active_stack.get("sweep"):
            return jsonify(ok=False, error="a lens sweep is running — cancel it instead"), 409
        finished, active_stack = active_stack, None
    unlock_exposure(finished.get("exposure_lock"))
    body = request.get_json(silent=True) or {}
    job, uploads = None, []
    # AF cameras always auto-stack; manual-focus rigs decide per stack.
    if (body.get("process") or camera.has_autofocus) and finished["count"] >= 2:
        job = start_job("focus-stack", finished["name"], run_focus_stack, finished["name"], None)
    elif finished["count"]:
        def compress_then_upload(name=finished["name"], stack_dir=Path(finished["dir"])):
            save_queue.wait_idle()
            compressor.add_stack(stack_dir, name)
            if CONFIG["upload"].get("stack_frames"):
                auto_upload("stack", name)  # processed stacks upload after processing
        threading.Thread(target=compress_then_upload, daemon=True).start()
    return jsonify(ok=True, name=finished["name"], frames=finished["count"],
                   job=job and job["id"], uploads=uploads)


@app.route("/api/stack/sweep", methods=["POST"])
def api_stack_sweep():
    """Automatic stack: step LensPosition from start to end (AF cameras only)."""
    global active_stack
    if not camera.has_autofocus:
        return jsonify(ok=False, error="lens sweep needs an autofocus camera"), 400
    body = request.get_json(silent=True) or {}
    sweep = {**CONFIG["sweep"], **{k: body[k] for k in ("start", "end", "steps", "settle_ms") if k in body}}
    lo, hi, _ = camera.camera_controls["LensPosition"]
    try:
        start, end = float(sweep["start"]), float(sweep["end"])
        steps, settle = int(sweep["steps"]), int(sweep["settle_ms"])
    except (TypeError, ValueError) as exc:
        return jsonify(ok=False, error=f"invalid sweep settings: {exc}"), 400
    if not (lo <= start <= hi and lo <= end <= hi) or not 2 <= steps <= 200:
        return jsonify(ok=False, error=f"LensPosition must be within {lo}..{hi}, steps 2..200"), 400
    label = body.get("label", "")
    with state_lock:
        if active_stack:
            return jsonify(ok=False, error=f"stack {active_stack['name']} still open"), 409
        if recording["active"]:
            return jsonify(ok=False, error="recording in progress"), 409
        base = data_dir("stacks")
        name = unique_stem(base, build_basename(label), "")
        (base / name).mkdir()
        meta = {"name": name, "label": label, "created": datetime.now().isoformat(timespec="seconds"),
                "sweep": {"start": start, "end": end, "steps": steps, "settle_ms": settle}}
        (base / name / "stack.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        active_stack = {"name": name, "dir": str(base / name), "count": 0, "sweep": True, "total": steps}
    active_stack["exposure_lock"] = lock_exposure_for_stack()
    job = start_job("sweep", name, run_sweep, name, sweep_positions(start, end, steps), settle, True)
    active_stack["job"] = job["id"]
    return jsonify(ok=True, name=name, job=job["id"])


@app.route("/api/jobs/<job_id>/cancel", methods=["POST"])
def api_job_cancel(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404)
    job["cancel"] = True
    if job["status"] == "queued":
        with jobs_lock:
            if job["id"] in stack_order:
                stack_order.remove(job["id"])
        job.update(status="error", error="cancelled", finished=time.time())
    if job["kind"] == "focus-stack" and job.get("pid") and job["status"] == "running":
        try:
            os.kill(job["pid"], 15)
        except OSError:
            pass
    return jsonify(ok=True)


@app.route("/api/stack/process/<name>", methods=["POST"])
def api_stack_process(name):
    if active_stack and active_stack["name"] == name:
        return jsonify(ok=False, error="stack still open — end it first"), 409
    safe_child(data_dir("stacks"), name)
    running = latest_job("focus-stack", name)
    if running and running["status"] in ("queued", "running"):
        return jsonify(ok=False, error="already processing", job=running["id"]), 409
    overrides = (request.get_json(silent=True) or {}).get("options") or {}
    unknown = set(overrides) - set(CONFIG["focus_stack"])
    if unknown:
        return jsonify(ok=False, error=f"unknown options: {sorted(unknown)}"), 400
    job = start_job("focus-stack", name, run_focus_stack, name, overrides)
    return jsonify(ok=True, job=job["id"])


def unprocessed_stacks():
    """Stacks with >= 2 frames, no result, not open and not already queued - oldest first."""
    base = data_dir("stacks")
    found = []
    for d in sorted((p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")),
                    key=lambda p: p.stat().st_mtime):
        if stack_busy(d.name) or "result" in stack_outputs(d, d.name):
            continue
        if len(stack_frames(d, d.name)) >= 2:
            found.append(d.name)
    return found


@app.route("/api/stacks/process_all", methods=["POST"])
def api_stacks_process_all():
    """Queue every unprocessed stack; they run one after another."""
    overrides = (request.get_json(silent=True) or {}).get("options") or {}
    unknown = set(overrides) - set(CONFIG["focus_stack"])
    if unknown:
        return jsonify(ok=False, error=f"unknown options: {sorted(unknown)}"), 400
    names = unprocessed_stacks()
    ids = [start_job("focus-stack", n, run_focus_stack, n, overrides)["id"] for n in names]
    return jsonify(ok=True, queued=len(ids), stacks=names, jobs=ids)


@app.route("/api/jobs")
def api_jobs():
    with jobs_lock:
        recent = sorted(jobs.values(), key=lambda j: j["created"], reverse=True)[:30]
    return jsonify(jobs=[dict(j, log=j["log"][-5:]) for j in recent])


@app.route("/api/jobs/<job_id>")
def api_job(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404)
    return jsonify(job)


FINISHED = ("done", "error")


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def api_job_delete(job_id):
    """Remove a finished job from the list (running ones can only be cancelled)."""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            abort(404)
        if job["status"] not in FINISHED:
            return jsonify(ok=False, error="job is still running — cancel it first"), 409
        del jobs[job_id]
    return jsonify(ok=True)


@app.route("/api/jobs/clear", methods=["POST"])
def api_jobs_clear():
    with jobs_lock:
        finished = [jid for jid, j in jobs.items() if j["status"] in FINISHED]
        for jid in finished:
            del jobs[jid]
    return jsonify(ok=True, removed=len(finished))


@app.route("/api/stacks")
def api_stacks():
    base = data_dir("stacks")
    stacks = []
    for d in sorted((p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")),
                    key=lambda p: p.stat().st_mtime, reverse=True):
        frames = stack_frames(d, d.name)
        job = latest_job("focus-stack", d.name)
        meta_file = d / "stack.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        stacks.append({
            "name": d.name,
            "label": meta.get("label", ""),
            "created": meta.get("created"),
            "frames": [f.name for f in frames],
            "outputs": stack_outputs(d, d.name),
            "open": bool(active_stack and active_stack["name"] == d.name),
            "job": job and {**{k: job[k] for k in ("id", "status", "error")},
                            "position": stack_queue_position(job["id"])},
        })
    return jsonify(stacks=stacks, unprocessed=len(unprocessed_stacks()))


def list_files(kind, exts, limit=100):
    base = data_dir(kind)
    files = sorted((f for f in base.iterdir() if f.is_file() and f.suffix.lower() in exts),
                   key=lambda f: f.stat().st_mtime, reverse=True)[:limit]
    return [{"name": f.name, "size": f.stat().st_size,
             "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds")}
            for f in files]


@app.route("/api/photos")
def api_photos():
    return jsonify(photos=list_files("photos", IMAGE_EXTS))


@app.route("/api/videos")
def api_videos():
    return jsonify(videos=list_files("videos", VIDEO_EXTS))


def drop_thumb(kind, relpath):
    stem = relpath.replace("/", "__")
    for suffix in (".jpg", ".large.jpg"):
        (data_dir(kind) / ".thumbs" / (stem + suffix)).unlink(missing_ok=True)


@app.route("/api/delete", methods=["POST"])
def api_bulk_delete():
    """Delete several photos / videos / stacks at once: {"photos": [...], "videos": [...],
    "stacks": [...]}. Each item goes through the normal single-delete checks; items that
    cannot be deleted (open or processing stack, recording video) are reported, not fatal."""
    from werkzeug.exceptions import HTTPException

    body = request.get_json(force=True) or {}
    handlers = {"photos": api_photo_delete, "videos": api_video_delete, "stacks": api_stack_delete}
    deleted, failed = [], []
    for kind, handler in handlers.items():
        for name in body.get(kind) or []:
            try:
                result = handler(str(name))
                status = result[1] if isinstance(result, tuple) else 200
                if status >= 400:
                    payload = result[0].get_json(silent=True) or {}
                    failed.append({"kind": kind, "name": name, "error": payload.get("error", f"HTTP {status}")})
                else:
                    deleted.append({"kind": kind, "name": name})
            except HTTPException as exc:
                failed.append({"kind": kind, "name": name, "error": "not found" if exc.code == 404 else str(exc)})
            except Exception as exc:
                failed.append({"kind": kind, "name": name, "error": str(exc)})
    return jsonify(ok=True, deleted=deleted, failed=failed)


@app.route("/api/photos/<name>", methods=["DELETE"])
def api_photo_delete(name):
    path = safe_child(data_dir("photos"), name)
    if not path.is_file():
        abort(404)
    path.unlink()
    if path.suffix.lower() != ".json":
        path.with_suffix(".json").unlink(missing_ok=True)
    drop_thumb("photos", name)
    return jsonify(ok=True)


@app.route("/api/videos/<name>", methods=["DELETE"])
def api_video_delete(name):
    if recording["active"] and recording["path"] and Path(recording["path"]).name == name:
        return jsonify(ok=False, error="video is still recording"), 409
    path = safe_child(data_dir("videos"), name)
    if not path.is_file():
        abort(404)
    path.unlink()
    return jsonify(ok=True)


@app.route("/api/stacks/<name>", methods=["DELETE"])
def api_stack_delete(name):
    if active_stack and active_stack["name"] == name:
        return jsonify(ok=False, error="stack is still open"), 409
    job = latest_job("focus-stack", name)
    if job and job["status"] in ("queued", "running"):
        return jsonify(ok=False, error="stack is being processed"), 409
    stack_dir = safe_child(data_dir("stacks"), name)
    if not stack_dir.is_dir():
        abort(404)
    shutil.rmtree(stack_dir)
    for cached in (data_dir("stacks") / ".thumbs").glob(f"{name}__*"):
        cached.unlink(missing_ok=True)
    return jsonify(ok=True)


@app.route("/api/stacks/<name>/frames", methods=["DELETE"])
def api_stack_frames_delete(name):
    """Drop the source frames of a processed stack, keeping the result."""
    stack_dir = safe_child(data_dir("stacks"), name)
    if active_stack and active_stack["name"] == name:
        return jsonify(ok=False, error="stack is still open"), 409
    job = latest_job("focus-stack", name)
    if job and job["status"] in ("queued", "running"):
        return jsonify(ok=False, error="stack is being processed"), 409
    if "result" not in stack_outputs(stack_dir, name):
        return jsonify(ok=False, error="stack has no result yet — frames kept"), 409
    return jsonify(ok=True, deleted=delete_stack_frames(stack_dir, name))


@app.route("/api/stacks/<name>/<filename>", methods=["DELETE"])
def api_stack_file_delete(name, filename):
    """Delete a single frame (or result) from a stack."""
    if active_stack and active_stack["name"] == name:
        return jsonify(ok=False, error="stack is still open"), 409
    path = safe_child(safe_child(data_dir("stacks"), name), filename)
    if not path.is_file() or path.name == "stack.json":
        abort(404)
    path.unlink()
    if path.suffix.lower() in IMAGE_EXTS:
        path.with_suffix(".json").unlink(missing_ok=True)
    drop_thumb("stacks", f"{name}/{filename}")
    return jsonify(ok=True)


@app.route("/api/upload", methods=["POST"])
def api_upload():
    body = request.get_json(force=True) or {}
    dest, kind, name = body.get("dest"), body.get("kind"), body.get("name", "")
    if dest not in ("drive", "nas") or kind not in ("photo", "stack", "video") or not name:
        return jsonify(ok=False, error="need dest (drive/nas), kind (photo/stack/video) and name"), 400
    job = start_job("upload", f"{kind}:{name}", run_upload, dest, kind, name)
    return jsonify(ok=True, job=job["id"])


# --------------------------------------------------------------------------
# Routes — settings
# --------------------------------------------------------------------------

EDITABLE_SETTINGS = {"filename_pattern", "image_format", "jpeg_quality", "png_compress_level",
                     "save_metadata", "persist_controls", "next_seq", "focus_stack", "upload",
                     "video", "camera", "sweep", "ui", "crop"}


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        unknown = set(body) - EDITABLE_SETTINGS
        if unknown:
            return jsonify(ok=False, error=f"not editable: {sorted(unknown)}"), 400
        if "crop" in body:
            c = body["crop"] if isinstance(body["crop"], dict) else {}
            clean = {"enabled": bool(c.get("enabled")), "aspect": str(c.get("aspect") or "3:4")}
            for key, default in (("size", 1.0), ("cx", 0.5), ("cy", 0.5), ("x", 0.0), ("y", 0.0), ("w", 1.0), ("h", 1.0)):
                try:
                    value = float(c.get(key, default))
                    clean[key] = min(1.0, max(0.0, value)) if value == value else default  # NaN -> default
                except (TypeError, ValueError):
                    clean[key] = default
            body["crop"] = clean
        if "filename_pattern" in body:
            try:
                format_name(body["filename_pattern"], "label", 1)
            except (KeyError, ValueError, IndexError, AttributeError) as exc:
                return jsonify(ok=False, error=f"invalid filename pattern: {exc!r}"), 400
        with config_lock:
            for key, value in body.items():
                if isinstance(value, dict) and isinstance(CONFIG.get(key), dict):
                    CONFIG[key] = deep_merge(CONFIG[key], value)
                else:
                    CONFIG[key] = value
            save_config()
    settings = {k: CONFIG.get(k) for k in sorted(EDITABLE_SETTINGS)}
    try:
        example = format_name(CONFIG["filename_pattern"], "Space_Marine", CONFIG.get("next_seq", 1))
    except Exception as exc:
        example = f"(error: {exc})"
    return jsonify(ok=True, settings=settings, example_name=example)


@app.route("/api/settings/preview_name", methods=["POST"])
def api_preview_name():
    body = request.get_json(force=True) or {}
    try:
        name = format_name(body.get("pattern", ""), body.get("label", "Space_Marine"),
                           CONFIG.get("next_seq", 1))
        return jsonify(ok=True, name=name)
    except Exception as exc:
        return jsonify(ok=False, error=repr(exc))


# --------------------------------------------------------------------------
# Routes — connect Google Drive (rclone OAuth, headless-friendly)
# --------------------------------------------------------------------------
#
# `rclone authorize drive` runs its OAuth callback server on the Pi at
# 127.0.0.1:53682. The user's browser is usually on another machine, so after
# Google consent it lands on an unreachable 127.0.0.1 URL; the user pastes that
# URL back into the UI and we replay it against rclone locally.

RCLONE_AUTH_PORT = 53682
drive_auth = {"proc": None, "output": [], "google_url": None}


def drive_remote_name():
    return (CONFIG["upload"].get("rclone_remote") or "gdrive:MiniatureStudio").split(":")[0] or "gdrive"


def parse_rclone_token(output):
    """Token JSON from `rclone authorize` output (between '--->' and '<---End paste')."""
    import base64

    m = re.search(r"--->\s*(.+?)\s*<---End paste", output, re.DOTALL)
    blob = m.group(1).strip() if m else ""
    if not blob.startswith("{"):
        try:  # some rclone versions print a base64 config blob instead
            decoded = json.loads(base64.b64decode(blob + "=" * (-len(blob) % 4)))
            blob = decoded.get("token", "") if isinstance(decoded, dict) else ""
        except Exception:
            m = re.search(r"(\{\s*\"access_token\".*?\})\s*$", output, re.MULTILINE)
            blob = m.group(1) if m else ""
    return blob if "access_token" in blob else None


def _stop_drive_auth():
    proc = drive_auth.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
    drive_auth.update(proc=None, output=[], google_url=None)


@app.route("/api/drive/status")
def api_drive_status():
    _drive_check["at"] = 0  # force a fresh check
    return jsonify(ok=True, rclone=bool(shutil.which("rclone")), connected=drive_available(),
                   remote=CONFIG["upload"].get("rclone_remote"),
                   pending=bool(drive_auth.get("proc") and drive_auth["proc"].poll() is None))


@app.route("/api/drive/connect/start", methods=["POST"])
def api_drive_connect_start():
    import http.client

    rclone = shutil.which("rclone")
    if not rclone:
        return jsonify(ok=False, error="rclone is not installed (sudo apt install rclone)"), 400
    _stop_drive_auth()
    proc = subprocess.Popen([rclone, "authorize", "drive", "--auth-no-open-browser"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    drive_auth["proc"] = proc

    def reader():
        for line in proc.stdout:
            drive_auth["output"].append(line.rstrip())

    threading.Thread(target=reader, daemon=True).start()
    local_url = None
    deadline = time.time() + 20
    while time.time() < deadline and not local_url:
        for line in drive_auth["output"]:
            m = re.search(rf"http://127\.0\.0\.1:{RCLONE_AUTH_PORT}/auth\?state=[\w-]+", line)
            if m:
                local_url = m.group(0)
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    if not local_url:
        _stop_drive_auth()
        return jsonify(ok=False, error="rclone did not start the authorization: "
                       + " / ".join(drive_auth["output"][-5:])), 500
    # rclone's /auth endpoint only redirects to Google; fetch that redirect here.
    conn = http.client.HTTPConnection("127.0.0.1", RCLONE_AUTH_PORT, timeout=10)
    conn.request("GET", local_url.split(str(RCLONE_AUTH_PORT), 1)[1])
    resp = conn.getresponse()
    google_url = resp.getheader("Location")
    conn.close()
    if not google_url:
        _stop_drive_auth()
        return jsonify(ok=False, error="could not get the Google sign-in URL from rclone"), 500
    drive_auth["google_url"] = google_url
    return jsonify(ok=True, url=google_url)


@app.route("/api/drive/connect/finish", methods=["POST"])
def api_drive_connect_finish():
    from urllib.parse import urlparse
    import http.client

    proc = drive_auth.get("proc")
    if not proc or proc.poll() is not None:
        return jsonify(ok=False, error="no authorization in progress — start again"), 409
    pasted = ((request.get_json(force=True) or {}).get("url") or "").strip()
    query = urlparse(pasted).query if "://" in pasted else pasted.lstrip("?")
    if "code=" not in query or "state=" not in query:
        return jsonify(ok=False, error="that URL has no code/state — copy the full address from the browser"), 400
    conn = http.client.HTTPConnection("127.0.0.1", RCLONE_AUTH_PORT, timeout=15)
    conn.request("GET", "/?" + query)
    conn.getresponse().read()
    conn.close()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        _stop_drive_auth()
        return jsonify(ok=False, error="rclone did not finish the authorization"), 500
    output = "\n".join(drive_auth["output"])
    token = parse_rclone_token(output)
    if not token:
        _stop_drive_auth()
        return jsonify(ok=False, error="no token received: " + output[-300:]), 500
    remote = drive_remote_name()
    rclone = shutil.which("rclone")
    subprocess.run([rclone, "config", "delete", remote], capture_output=True)
    created = subprocess.run([rclone, "config", "create", remote, "drive", "scope", "drive",
                              "token", token, "--non-interactive"], capture_output=True, text=True)
    _stop_drive_auth()
    if created.returncode != 0:
        return jsonify(ok=False, error="rclone config create failed: " + created.stderr[-300:]), 500
    target = CONFIG["upload"].get("rclone_remote") or f"{remote}:MiniatureStudio"
    subprocess.run([rclone, "mkdir", target], capture_output=True, timeout=60)
    CONFIG["upload"]["rclone_remote"] = target
    save_config()
    _drive_check["at"] = 0
    return jsonify(ok=True, remote=target, connected=drive_available())


@app.route("/api/drive/disconnect", methods=["POST"])
def api_drive_disconnect():
    _stop_drive_auth()
    rclone = shutil.which("rclone")
    if rclone:
        subprocess.run([rclone, "config", "delete", drive_remote_name()], capture_output=True)
    _drive_check["at"] = 0
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Routes — mount a NAS share (SMB/NFS) via the root helper
# --------------------------------------------------------------------------
#
# Mounting needs root. install.sh installs scripts/miniaturestudio-mount as
# /usr/local/sbin/miniaturestudio-mount (root-owned) plus a sudoers rule that lets
# the service user run only that helper. It writes an fstab entry, so the
# share is mounted again at every boot.

MOUNT_HELPER = "/usr/local/sbin/miniaturestudio-mount"


def run_mount_helper(action, payload=None):
    if not Path(MOUNT_HELPER).exists():
        raise RuntimeError("mount helper not installed — run ./install.sh again")
    proc = subprocess.run(["sudo", "-n", MOUNT_HELPER, action], input=json.dumps(payload or {}),
                          capture_output=True, text=True, timeout=90)
    try:
        result = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        result = {}
    if proc.returncode != 0:
        raise RuntimeError(result.get("error") or proc.stderr.strip() or f"{action} failed")
    return result


@app.route("/api/nas/status")
def api_nas_status():
    try:
        status = run_mount_helper("status")
    except Exception as exc:
        status = {"configured": False, "error": str(exc)}
    return jsonify(ok=True, available=nas_available(), nas_path=CONFIG["upload"].get("nas_path"), **status)


@app.route("/api/nas/mount", methods=["POST"])
def api_nas_mount():
    body = request.get_json(force=True) or {}
    payload = {k: body.get(k, "") for k in
               ("type", "server", "share", "username", "password", "domain", "version", "mount_point")}
    try:
        result = run_mount_helper("mount", payload)
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400
    CONFIG["upload"]["nas_path"] = str(Path(result["mount_point"]) / "MiniatureStudio")
    save_config()
    try:
        Path(CONFIG["upload"]["nas_path"]).mkdir(exist_ok=True)
    except OSError as exc:
        return jsonify(ok=False, error=f"mounted, but cannot write to the share: {exc}"), 400
    return jsonify(ok=True, nas_path=CONFIG["upload"]["nas_path"], **result)


@app.route("/api/nas/unmount", methods=["POST"])
def api_nas_unmount():
    try:
        return jsonify(ok=True, **run_mount_helper("unmount"))
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400


# --------------------------------------------------------------------------
# Routes — storage: SD card or a USB disk (saves wear on the SD card)
# --------------------------------------------------------------------------

USB_FSTYPES = {"ext4", "vfat", "exfat", "ntfs"}


def list_usb_disks():
    """USB partitions with a filesystem (lsblk works without root)."""
    try:
        out = subprocess.run(["lsblk", "-J", "-b", "-o",
                              "NAME,PATH,LABEL,FSTYPE,SIZE,FSAVAIL,MOUNTPOINT,TRAN,UUID,MODEL,TYPE"],
                             capture_output=True, text=True, timeout=10)
        devices = json.loads(out.stdout or "{}").get("blockdevices", [])
    except Exception:
        return []
    disks = []
    for dev in devices:
        if dev.get("tran") != "usb":
            continue
        for part in dev.get("children") or [dev]:
            if not part.get("fstype") or part.get("mountpoint") in ("/", "/boot", "/boot/firmware"):
                continue
            disks.append({
                "path": part.get("path"), "uuid": part.get("uuid"), "label": part.get("label"),
                "fstype": part.get("fstype"), "size": int(part.get("size") or 0),
                "model": (dev.get("model") or "").strip(), "mountpoint": part.get("mountpoint"),
                "supported": part.get("fstype") in USB_FSTYPES and bool(part.get("uuid")),
            })
    return disks


def disk_free(path):
    try:
        usage = shutil.disk_usage(path)
        return {"total": usage.total, "free": usage.free}
    except OSError:
        return None


def data_size(root_for_kind):
    """(files, bytes) of the photo/stack/video folders; root_for_kind(kind) -> Path."""
    files = size = 0
    for kind in DATA_KINDS:
        base = root_for_kind(kind)
        if not base.is_dir():
            continue
        for f in base.rglob("*"):
            if f.is_file() and ".thumbs" not in f.parts and ".tmp" not in f.parts:
                files += 1
                size += f.stat().st_size
    return files, size


def storage_busy():
    with state_lock:
        if recording["active"] or active_stack:
            return "stop recording / finish the stack first"
    if save_queue.status()["pending"]:
        return "wait until the last captures are written"
    with jobs_lock:
        if any(j["status"] in ("queued", "running") and j["kind"] in ("focus-stack", "move")
               for j in jobs.values()):
            return "wait until stack processing / moving has finished"
    return None


@app.route("/api/storage")
def api_storage():
    try:
        usb = run_mount_helper("usb-status")
    except Exception as exc:
        usb = {"configured": False, "mounted": False, "error": str(exc)}
    mounted = os.path.ismount(USB_MOUNT)
    sd_files, sd_bytes = data_size(sd_dir)
    usb_files = usb_bytes = 0
    if mounted:
        usb_files, usb_bytes = data_size(lambda k: USB_MOUNT / "MiniatureStudio" / k)
    return jsonify(ok=True, target=storage_target(), usb=usb, usb_mounted=mounted,
                   disks=list_usb_disks(),
                   free={"sd": disk_free(BASE_DIR), "usb": disk_free(USB_MOUNT) if mounted else None},
                   data={"sd": {"files": sd_files, "bytes": sd_bytes},
                         "usb": {"files": usb_files, "bytes": usb_bytes}})


@app.route("/api/storage/usb", methods=["POST"])
def api_storage_usb():
    """Mount a USB partition persistently and store new captures there."""
    busy = storage_busy()
    if busy:
        return jsonify(ok=False, error=busy), 409
    uuid = (request.get_json(force=True) or {}).get("uuid", "")
    try:
        result = run_mount_helper("usb-mount", {"uuid": uuid})
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400
    CONFIG["storage"] = {"target": "usb", "uuid": result.get("uuid"), "label": result.get("label"),
                         "fstype": result.get("fstype")}
    save_config()
    for kind in DATA_KINDS:
        data_dir(kind)
    files, size = data_size(sd_dir)
    return jsonify(ok=True, usb=result, sd_data={"files": files, "bytes": size})


@app.route("/api/storage/sd", methods=["POST"])
def api_storage_sd():
    """Back to the SD card. forget=true also unmounts the USB disk and removes it from fstab."""
    busy = storage_busy()
    if busy:
        return jsonify(ok=False, error=busy), 409
    forget = bool((request.get_json(silent=True) or {}).get("forget"))
    usb_data = {"files": 0, "bytes": 0}
    if os.path.ismount(USB_MOUNT):
        files, size = data_size(lambda k: USB_MOUNT / "MiniatureStudio" / k)
        usb_data = {"files": files, "bytes": size}
    if forget:
        try:
            run_mount_helper("usb-remove")
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 400
    CONFIG["storage"] = {**CONFIG.get("storage", {}), "target": "sd"}
    save_config()
    return jsonify(ok=True, usb_data=usb_data)


@app.route("/api/storage/eject", methods=["POST"])
def api_storage_eject():
    """Safely remove the USB disk (it stays configured and is re-mounted when replugged)."""
    busy = storage_busy()
    if busy:
        return jsonify(ok=False, error=busy), 409
    try:
        return jsonify(ok=True, **run_mount_helper("usb-eject"))
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400


def run_move_data(job, direction):
    """Move photos/stacks/videos between the SD card and the USB disk (copy, verify, delete)."""
    usb_base = usb_root()
    src_of = sd_dir if direction == "to_usb" else (lambda k: usb_base / k)
    dst_of = (lambda k: usb_base / k) if direction == "to_usb" else sd_dir
    files, size = data_size(src_of)
    free = disk_free(dst_of("photos").parent if direction == "to_usb" else BASE_DIR)
    if free and size > free["free"] - 200 * 1024 * 1024:
        raise RuntimeError(f"not enough space: need {size / 1e9:.1f} GB, "
                           f"{free['free'] / 1e9:.1f} GB free")
    queued_raw = {i["raw"] for i in compressor.items}  # being compressed: leave in place
    moved = skipped = 0
    job_log(job, f"Moving {files} files ({size / 1e9:.2f} GB)")
    for kind in DATA_KINDS:
        src_base, dst_base = src_of(kind), dst_of(kind)
        if not src_base.is_dir():
            continue
        for f in sorted(p for p in src_base.rglob("*") if p.is_file()):
            if job.get("cancel"):
                job_log(job, "Cancelled")
                return {"moved": moved, "skipped": skipped, "cancelled": True}
            rel = f.relative_to(src_base)
            if ".thumbs" in rel.parts or ".tmp" in rel.parts or f.name.endswith(".part") \
                    or str(f) in queued_raw:
                skipped += 1
                continue
            target = dst_base / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.stat().st_size == f.stat().st_size:
                f.unlink()  # already copied in an earlier (interrupted) run
            else:
                shutil.copyfile(f, target)  # copyfile: FAT/exFAT cannot keep Unix modes
                if target.stat().st_size != f.stat().st_size:
                    raise RuntimeError(f"copy of {rel} is incomplete — stopped, nothing deleted")
                f.unlink()
            moved += 1
            if moved % 25 == 0:
                job_log(job, f"{moved}/{files} files moved")
        shutil.rmtree(src_base / ".thumbs", ignore_errors=True)
        for d in sorted((p for p in src_base.rglob("*") if p.is_dir()), reverse=True):
            try:
                d.rmdir()  # only removes empty folders
            except OSError:
                pass
    job_log(job, f"Done: {moved} moved, {skipped} skipped")
    return {"moved": moved, "skipped": skipped}


@app.route("/api/storage/move", methods=["POST"])
def api_storage_move():
    direction = (request.get_json(force=True) or {}).get("direction", "to_usb")
    if direction not in ("to_usb", "to_sd"):
        return jsonify(ok=False, error="direction must be to_usb or to_sd"), 400
    busy = storage_busy()
    if busy:
        return jsonify(ok=False, error=busy), 409
    if not os.path.ismount(USB_MOUNT):
        return jsonify(ok=False, error="USB disk not mounted"), 409
    return jsonify(ok=True, job=start_job("move", direction, run_move_data, direction)["id"])


# --------------------------------------------------------------------------
# Routes — system: Raspberry Pi stats, restart / reboot / shutdown
# --------------------------------------------------------------------------

def read_text(path, default=None):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").strip().strip("\x00")
    except OSError:
        return default


_cpu_sample = {}


def cpu_usage_percent():
    """CPU busy % since the previous call (from /proc/stat)."""
    line = read_text("/proc/stat", "").splitlines()[:1]
    if not line:
        return None
    values = [int(v) for v in line[0].split()[1:]]
    idle, total = values[3] + values[4], sum(values)
    prev = _cpu_sample.get("last")
    _cpu_sample["last"] = (idle, total)
    if not prev or total == prev[1]:
        return None
    return round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)


# Bits of `vcgencmd get_throttled` (Raspberry Pi firmware).
THROTTLE_FLAGS = {0: "under-voltage", 1: "ARM frequency capped", 2: "throttled", 3: "soft temperature limit"}


def throttle_state():
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=5).stdout
        value = int(out.strip().split("=")[1], 16)
    except Exception:
        return None
    return {"raw": hex(value),
            "now": [name for bit, name in THROTTLE_FLAGS.items() if value & (1 << bit)],
            "since_boot": [name for bit, name in THROTTLE_FLAGS.items() if value & (1 << (bit + 16))]}


def os_name():
    for line in (read_text("/etc/os-release", "") or "").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    import platform
    return platform.platform()


@app.route("/api/system")
def api_system():
    import platform

    uptime = read_text("/proc/uptime")
    temp = read_text("/sys/class/thermal/thermal_zone0/temp")
    freq = read_text("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq")
    try:
        load = [round(v, 2) for v in os.getloadavg()]
    except (AttributeError, OSError):
        load = None
    try:
        ips = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout.split()
    except Exception:
        ips = []
    disks = {"sd": disk_free(BASE_DIR)}
    if os.path.ismount(USB_MOUNT):
        disks["usb"] = disk_free(USB_MOUNT)
    try:
        version = git("describe", "--tags", "--always", "--dirty")
    except Exception:
        version = "unknown"
    return jsonify(
        ok=True,
        model=read_text("/proc/device-tree/model") or platform.machine(),
        os=os_name(),
        kernel=platform.release(),
        python=platform.python_version(),
        hostname=platform.node(),
        ips=ips,
        uptime_s=int(float(uptime.split()[0])) if uptime else None,
        cpu={"cores": os.cpu_count(), "usage": cpu_usage_percent(), "load": load,
             "freq_mhz": int(freq) // 1000 if freq else None,
             "temp_c": round(int(temp) / 1000, 1) if temp else None},
        memory={"total_mb": meminfo_mb("MemTotal"), "available_mb": meminfo_mb("MemAvailable"),
                "swap_total_mb": meminfo_mb("SwapTotal"), "swap_free_mb": meminfo_mb("SwapFree")},
        throttle=throttle_state(),
        disks=disks,
        app={"version": version, "camera": camera.model, "demo": camera.demo,
             "stacker": stack_method(CONFIG["focus_stack"])[0]},
    )


class MemoryLogHandler(logging.Handler):
    """Last log lines in memory: fallback when the systemd journal is not readable."""

    def __init__(self, size=3000):
        super().__init__()
        import collections
        self.lines = collections.deque(maxlen=size)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record):
        try:
            self.lines.append(self.format(record))
        except Exception:
            pass


memory_log = MemoryLogHandler()
WEB_REQUEST = re.compile(r'werkzeug: .*"(GET|POST|DELETE|PUT) ')


def read_journal(lines, unit="miniaturestudio", kernel=False):
    """Journal lines for the service (or the kernel) since boot; None if not readable."""
    cmd = ["journalctl", "-b", "--no-pager", "-o", "short-iso", "-n", str(lines)]
    cmd += ["-k"] if kernel else ["-u", unit]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    text = out.stdout.strip()
    if out.returncode != 0 or not text or "No journal files" in text:
        return None
    return text.splitlines()


def app_log_lines(lines=300, requests=False):
    """(source, lines): the systemd journal when readable (includes libcamera's own
    messages), otherwise the in-memory log of this process."""
    fetch = lines * 4 if not requests else lines  # page requests are most of the journal
    journal = read_journal(fetch)
    source, data = ("journal", journal) if journal else ("memory", list(memory_log.lines))
    if not requests:
        data = [l for l in data if not WEB_REQUEST.search(l)]
    return source, data[-lines:]


@app.route("/api/system/log")
def api_system_log():
    lines = min(max(int(request.args.get("lines", 300)), 20), 5000)
    source, data = app_log_lines(lines, request.args.get("requests") == "1")
    return jsonify(ok=True, source=source, lines=data)


@app.route("/download/debug-log")
def download_debug_log():
    """One text file with everything useful for debugging."""
    now = datetime.now()
    parts = [f"MiniatureStudio debug log — {now.isoformat(timespec='seconds')}"]

    def section(title, body):
        parts.append(f"\n===== {title} =====\n{body}")

    try:
        section("System", json.dumps(api_system().get_json(), indent=2))
    except Exception as exc:
        section("System", f"unavailable: {exc}")
    with state_lock:
        state = {"recording": dict(recording), "stack": active_stack and {**active_stack, "exposure_lock": None}}
    section("State", json.dumps(jsonable({**state, "saving": save_queue.status(),
                                            "compressing": compressor.status(),
                                            "camera_mode": getattr(camera, "mode", None),
                                            "applied_controls": camera.applied}), indent=2))
    section("Settings (config.json)", json.dumps(CONFIG, indent=2, default=str))
    with jobs_lock:
        recent = sorted(jobs.values(), key=lambda j: j["created"], reverse=True)[:15]
    section("Recent jobs", "\n\n".join(
        f"[{j['kind']}] {j['name']} — {j['status']}{' — ' + j['error'] if j.get('error') else ''}\n"
        + "\n".join(j["log"][-80:]) for j in recent) or "none")
    source, data = app_log_lines(5000, requests=False)
    section(f"App log since boot (source: {source}, web requests left out)", "\n".join(data))
    try:
        diag = camera_diagnostics()
        section("Camera check", f"Verdict: {diag['verdict']}\n\nrpicam-hello --list-cameras:\n{diag['list_cameras']}"
                f"\n\n{diag['config']['path']}:\n" + ("\n".join(diag["config"]["lines"]) or "(no camera lines)")
                + "\n\nKernel camera messages:\n" + "\n".join(diag["kernel"]))
    except Exception as exc:
        section("Camera check", f"failed: {exc}")
    kernel = read_journal(5000, kernel=True) or []
    relevant = re.compile(r"imx\d|ov\d|arducam|unicam|camera|i2c|voltage|throttl|usb|mmc|error|fail", re.I)
    section("Kernel messages (camera, USB, power, errors)",
            "\n".join([l for l in kernel if relevant.search(l)][-300:]) or "not readable")
    body = "\n".join(parts) + "\n"
    return Response(body, mimetype="text/plain; charset=utf-8", headers={
        "Content-Disposition": f"attachment; filename=miniaturestudio-debug-{now:%Y%m%d_%H%M%S}.txt"})


def power_blocker():
    with state_lock:
        if recording["active"]:
            return "a video is recording — stop it first"
        if active_stack:
            return "a stack is open — finish it first"
    return None


def power_action(action):
    """Wait for pending writes, then restart the app, reboot or power off."""
    save_queue.wait_idle()
    if hasattr(os, "sync"):
        os.sync()
    if action == "restart":
        os._exit(0)  # systemd (Restart=always) starts the app again
    cmd = ["sudo", "-n", "/usr/bin/systemctl", "reboot" if action == "reboot" else "poweroff"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        log.error("%s failed: %s", action, result.stderr.strip())


@app.route("/api/system/<action>", methods=["POST"])
def api_system_power(action):
    if action not in ("restart", "reboot", "shutdown"):
        abort(404)
    blocker = power_blocker()
    if blocker:
        return jsonify(ok=False, error=blocker), 409
    if os.name != "posix":
        return jsonify(ok=False, error="only available on the Pi"), 400
    if action != "restart" and subprocess.run(["sudo", "-n", "-l", "/usr/bin/systemctl", "reboot"],
                                              capture_output=True).returncode != 0:
        return jsonify(ok=False, error="no permission — run ./install.sh again (adds the sudo rule)"), 403
    running = [j["kind"] for j in jobs.values() if j["status"] in ("queued", "running")]
    log.warning("System %s requested (running jobs: %s)", action, running or "none")
    threading.Timer(1.0, power_action, args=(action,)).start()
    return jsonify(ok=True, action=action, interrupted_jobs=running)


# --------------------------------------------------------------------------
# Routes — self-update (git based, see update.sh)
# --------------------------------------------------------------------------

def git(*args, timeout=30):
    out = subprocess.run(["git", "-C", str(BASE_DIR), *args], capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"git {args[0]} failed")
    return out.stdout.strip()


@app.route("/api/version")
def api_version():
    try:
        return jsonify(ok=True, version=git("describe", "--tags", "--always", "--dirty"),
                       branch=git("rev-parse", "--abbrev-ref", "HEAD"))
    except Exception as exc:
        return jsonify(ok=True, version="unknown", error=str(exc))


@app.route("/api/update/check", methods=["POST"])
def api_update_check():
    git("fetch", "--quiet", "--tags", "origin", timeout=60)
    behind = int(git("rev-list", "--count", "HEAD..@{u}"))
    changes = git("log", "--format=%h %s", "HEAD..@{u}").splitlines() if behind else []
    return jsonify(ok=True, behind=behind, changes=changes[:50],
                   version=git("describe", "--tags", "--always", "--dirty"))


def run_self_update(job):
    if os.name == "nt":
        raise RuntimeError("self-update only works on the Pi")
    proc = subprocess.Popen([str(BASE_DIR / "update.sh"), "--no-restart"], cwd=BASE_DIR,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        job_log(job, line)
    if proc.wait() != 0:
        raise RuntimeError("update.sh failed — see log")
    if os.environ.get("INVOCATION_ID"):  # running under systemd: exit and let it restart us
        job_log(job, "Restarting…")
        threading.Timer(1.5, lambda: os._exit(0)).start()
        return {"restarting": True}
    job_log(job, "Updated — restart the app to load the new version")
    return {"restarting": False}


@app.route("/api/update/apply", methods=["POST"])
def api_update_apply():
    if recording["active"] or active_stack:
        return jsonify(ok=False, error="stop recording / finish the stack first"), 409
    with jobs_lock:
        busy = [j for j in jobs.values() if j["status"] in ("queued", "running")]
    if busy:
        return jsonify(ok=False, error="wait until running jobs have finished"), 409
    return jsonify(ok=True, job=start_job("update", "miniaturestudio", run_self_update)["id"])


@app.errorhandler(Exception)
def handle_error(exc):
    from werkzeug.exceptions import HTTPException
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, StorageUnavailable):
        return jsonify(ok=False, error=str(exc), storage_unavailable=True), 503
    log.exception("Unhandled error")
    return jsonify(ok=False, error=str(exc)), 500


# --------------------------------------------------------------------------

def main():
    global camera
    import argparse

    parser = argparse.ArgumentParser(description="MiniatureStudio — photo studio web app for tabletop miniatures")
    parser.add_argument("--host", default=CONFIG["server"]["host"])
    parser.add_argument("--port", type=int, default=CONFIG["server"]["port"])
    parser.add_argument("--demo", action="store_true", help="run without a camera")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger().addHandler(memory_log)
    if args.demo:
        os.environ["MINIATURESTUDIO_DEMO"] = "1"
    global save_queue, compressor, stack_queue
    import queue
    stack_queue = queue.Queue()
    threading.Thread(target=_stack_worker, daemon=True, name="focus-stack-queue").start()
    save_queue = SaveQueue(int(CONFIG["camera"].get("save_queue", 2)))
    compressor = Compressor(BASE_DIR / ".compress_queue.json", int(CONFIG["camera"].get("compress_workers", 0)))
    try:
        camera = open_camera()
    except Exception as exc:
        # Never let a missing or broken camera take the whole web app down.
        log.exception("Opening the camera failed — starting without a camera")
        camera = NoCamera(exc)
    atexit.register(lambda: camera.close())
    threading.Thread(target=focus_hold_watchdog, daemon=True).start()
    restore_controls(camera)
    binary = find_focus_stack()
    log.info("focus-stack: %s", binary or "NOT FOUND (run ./install.sh)")
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
