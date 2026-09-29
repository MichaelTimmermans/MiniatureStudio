"use strict";

// Explanations behind the ⓘ icons. Keys: libcamera control names (Camera tab) and
// setting keys (Settings tab / stacking options). Unknown keys simply get no icon.
const HELP = {
  // ---------------------------------------------------------------- exposure
  AeEnable: "Automatic exposure. On: the camera chooses exposure time and gain itself. Off: your ExposureTime and AnalogueGain are used exactly. For a static model under fixed lights, manual (off) gives identical frames — best for stacking.",
  ExposureTimeMode: "Newer libcamera: Auto lets the camera pick the exposure time, Manual uses your ExposureTime.",
  AnalogueGainMode: "Newer libcamera: Auto lets the camera pick the gain, Manual uses your AnalogueGain.",
  ExposureTime: "Shutter time in microseconds (1,000,000 µs = 1 s). Longer = brighter image with less noise. The model does not move, so long exposures (1/15 s or longer) are fine. Only used when auto exposure is off.",
  AnalogueGain: "Sensor amplification, like ISO. 1.0 = the least noise. Raise it only if the exposure time cannot go longer; high gain gives speckles in the black backdrop.",
  ExposureValue: "Exposure compensation for auto exposure, in stops. -1 = half as bright, +1 = twice as bright. Handy against blown highlights while keeping auto exposure.",
  AeMeteringMode: "Which part of the image auto exposure looks at. CentreWeighted: mostly the centre (good for a centred model). Spot: only the very centre. Matrix: the whole frame (a black backdrop then makes it expose too bright).",
  AeConstraintMode: "How auto exposure treats extremes. Normal: balanced. Highlight: protects bright parts from blowing out (useful for white/metallic paint). Shadows: lifts dark parts.",
  AeExposureMode: "Whether auto exposure prefers short (Short) or long (Long) exposure times when it has a choice. Long = less gain, less noise — suits a static model.",
  AeFlickerMode: "Cancels flicker from mains-powered lights (banding or brightness pulsing). Manual: uses AeFlickerPeriod. Auto: detects it (not supported everywhere).",
  AeFlickerPeriod: "Flicker period for AeFlickerMode Manual, in µs. Europe (50 Hz mains): 10000. USA (60 Hz): 8333.",
  FrameDurationLimits: "Minimum and maximum time per frame in µs. The maximum also limits the longest exposure time. Normally leave as is.",
  DigitalGain: "Extra brightness applied after the sensor. Adds no detail; prefer ExposureTime.",

  // ---------------------------------------------------------------- colour
  AwbEnable: "Automatic white balance. On: the camera neutralises colour casts itself. Off: ColourGains (or ColourTemperature) are used — keeps colours identical from shot to shot.",
  AwbMode: "Which light automatic white balance expects: Auto, Incandescent/Tungsten (warm bulbs), Fluorescent, Indoor, Daylight, Cloudy. Pick the one matching your booth lights if Auto drifts.",
  ColourGains: "Manual white balance: two numbers, the red gain and the blue gain. Raise red for a warmer image, blue for a cooler one. Only used when AwbEnable is off. Tip: 'Lock exposure & WB' fills these in from the current automatic values.",
  ColourTemperature: "Manual white balance in Kelvin (newer libcamera). ~2700 K = warm bulb, ~4000 K = neutral LED, ~5500-6500 K = daylight. Match your lamps.",
  Saturation: "Colour intensity. 1 = normal, 0 = black & white, above 1 = more vivid. Keep near 1 for true-to-paint colours.",
  Contrast: "Difference between light and dark. 1 = normal. Higher = punchier but loses detail in shadows and highlights.",
  Brightness: "Shifts the whole image lighter or darker (-1 … 1). This is not exposure: it does not reduce noise. Prefer ExposureTime.",
  ColourCorrectionMatrix: "Advanced: 3x3 matrix that converts the sensor colours. Normally set by the camera's tuning file — leave alone.",

  // ---------------------------------------------------------------- detail / quality
  Sharpness: "In-camera sharpening. 0 = none, 1 = normal. Sharpening draws bright rims around edges on a black backdrop (halo) — use 0 for stacking and sharpen afterwards if needed.",
  NoiseReductionMode: "Noise reduction. HighQuality: strongest, a bit slower. Fast / Minimal: lighter. Off: none (more speckles, most fine detail).",
  ScalerCrop: "Digital zoom: the part of the sensor that is used (x, y, width, height in sensor pixels). A smaller area zooms in but uses fewer real pixels.",
  HdrMode: "High dynamic range modes (only some cameras). Merges several exposures; not useful for stacking.",

  // ---------------------------------------------------------------- focus
  AfMode: "Autofocus mode (AF cameras only). Manual: the lens stays at LensPosition (use this for stacking). Auto: focuses once when triggered. Continuous: keeps refocusing.",
  AfRange: "Distance range autofocus searches. Macro: close subjects — good for miniatures. Normal / Full: further away / everything.",
  AfSpeed: "How fast autofocus moves. Fast is quicker, Normal is smoother.",
  AfMetering: "Where autofocus measures sharpness. Auto: the camera decides. Windows: specific areas (not set by this app).",
  LensPosition: "Lens focus distance in dioptres = 1 / distance in metres. 0 = infinity, 2 = 50 cm, 4 = 25 cm, 10 = 10 cm. Higher = closer. For the lens sweep set start and end around your model.",

  // ---------------------------------------------------------------- Settings: files
  filename_pattern: "How files are named. {dt:%Y%m%d_%H%M%S} = date and time, {label} = the label you type on the Capture tab, {seq:03d} = a counter (001, 002, …). Example: {seq:04d}_{label}.",
  next_seq: "The next number used for {seq} in the file name pattern. Change it to continue a numbering.",
  image_format: "File format for photos and stack frames. png: lossless, smaller files, compressed in the background. tif: lossless, no compression work (about 1.8× larger). jpg: small but lossy.",
  png_compress_level: "PNG compression 0-9. Always lossless: higher only makes files smaller and saving slower. 1-3 is a good balance on a Pi.",
  jpeg_quality: "JPG quality 1-100 (only for the jpg format). 95 is visually lossless for most uses.",
  save_metadata: "Saves a .json file next to every photo with the camera settings used (exposure, gain, white balance, lens position…).",
  persist_controls: "Restore your last camera settings after a restart when no boot preset is set.",

  // ---------------------------------------------------------------- Settings: camera & performance
  lock_exposure_in_stacks: "At the start of a stack, freeze auto exposure and white balance so every frame matches. Frames that differ in brightness or colour cause halos. Auto returns after the stack.",
  preview_mode: "fast: the live view uses a quick half-resolution sensor mode and switches to full resolution only for each capture — smooth preview. full: always full resolution — slower preview, no switch per capture.",
  save_queue: "How many captured frames may wait to be written at once. Each one takes ~36 MB of RAM (12 MP). On a 1 GB Pi 3B keep 2.",
  compress_workers: "Background workers that compress TIFF to PNG. 0 = one per CPU core minus one. They run at low priority. Applies after a restart.",

  // ---------------------------------------------------------------- Settings: upload
  auto_drive: "Upload photos, videos and finished stacks to Google Drive automatically as soon as they are saved (needs Connect Google Drive).",
  rclone_remote: "Where on Google Drive files go, as rclone remote:folder. Default gdrive:MiniatureStudio.",
  auto_nas: "Copy photos, videos and finished stacks to the NAS automatically.",
  nas_path: "Folder on the mounted NAS share where files are copied to. Set automatically when you use Mount NAS.",
  nas_require_mount: "Refuse to copy when the NAS folder is not on a mounted share — otherwise files would silently fill the SD card.",
  stack_frames: "Also upload every source frame of a stack. Off: only the stacked result (and depth map) is uploaded.",

  // ---------------------------------------------------------------- Settings: lens sweep
  start: "LensPosition (dioptres) of the first frame of an automatic lens sweep. Tip: focus on the front of the model and press 'Current → start'.",
  end: "LensPosition (dioptres) of the last frame. Tip: focus on the back of the model and press 'Current → end'.",
  steps: "Number of frames in the sweep. More frames with smaller steps = less halo and more even sharpness, but longer processing.",
  settle_ms: "Waiting time after moving the lens before each frame, so the lens has stopped moving. Raise it if frames look blurry.",

  // ---------------------------------------------------------------- stacking
  method: "halofree: made for miniatures on a black backdrop — no glow around bright edges, low memory use. focus-stack: the classic wavelet stacker; can give slightly crisper micro-detail but draws halos on dark backgrounds.",
  halofree_threshold: "Halo-free: how much sharper than the sensor noise an area must be to count as detail. Higher = less backdrop noise treated as detail; too high loses faint detail.",
  halofree_band: "Halo-free: width of the zone around the model where glow is removed, in half-resolution pixels. Raise it if a faint glow remains further out.",
  output_format: "File format of the stacked result: png (lossless), tif (lossless, larger) or jpg (small, lossy).",
  consistency: "focus-stack: filters isolated pixels that come from a different frame than their neighbours. 2 = strongest, least noise. 0 = off.",
  denoise: "focus-stack: noise reduction on the merged image. 1.0 = default, 0 = off, higher = smoother.",
  threads: "focus-stack: number of CPU threads. Empty = automatic, based on the Pi's memory (1 on a 1 GB Pi 3B). More threads use more memory.",
  batchsize: "focus-stack: how many frames are merged at once. 0 = all in one batch (best quality, most memory). On a 1 GB Pi 3B keep 2-4.",
  delete_frames: "Delete the source frames after a successful stack to save space. The result is kept; if frames are uploaded too, that happens first.",
  jpgquality: "Quality 1-100 when the stacked result is saved as jpg.",
  reference: "Frame number (starting at 0) that all others are aligned to. Empty = the middle frame, usually best.",
  remove_bg: "focus-stack: makes the background transparent. A positive number removes a black background below that brightness, a negative one a white background.",
  global_align: "focus-stack: align every frame directly to the reference instead of to its neighbour. Can help when the stack jumps.",
  full_resolution_align: "focus-stack: align at full resolution instead of max 2048 px. Slightly more precise, much slower and more memory.",
  no_whitebalance: "focus-stack: do not correct colour differences between frames.",
  no_contrast: "focus-stack: do not correct brightness/contrast differences between frames.",
  no_transform: "focus-stack: do not correct position/size differences (focus breathing) between frames.",
  no_align: "focus-stack: skip alignment completely. Only for frames that are already perfectly aligned.",
  align_keep_size: "focus-stack: keep the original image size instead of cropping the borders that alignment leaves empty.",
  nocrop: "focus-stack: save the full image including edges that had to be extrapolated.",
  no_opencl: "focus-stack: do not use GPU acceleration (OpenCL). Leave on for Raspberry Pi — it has no usable OpenCL.",
  depthmap: "Also save a depth map: an image showing which frame each part of the result came from (near = light, far = dark).",
  view3d: "focus-stack: also save a 3D preview rendered from the depth map.",
  verbose: "focus-stack: more detail in the job log.",
  extra_args: "Extra command-line options passed straight to focus-stack (for experts).",
};
