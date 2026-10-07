# Focus stacking

[← Documentation](README.md)

A stack is a series of photos of the same model, each focused at a different
depth; the app merges the sharp parts into one image.

## Taking a stack

Capture tab → **Focus stack**. Autofocus cameras get a choice between
**Manual — frame by frame** and **Automatic — lens sweep**; **Start stack**
follows that choice. Cameras without autofocus only have the manual mode.

- **Manual:** **Start stack**, set the focus (turn the focus ring, or change
  LensPosition in the Camera tab on an autofocus camera), press **+ Frame** (or
  Space) for each depth, then **Finish**.
- **Automatic — lens sweep:** the app moves the lens and takes all frames by
  itself. Focus on the front of the model and press **Current → start**, focus
  on the back and press **Current → end**, choose the number of steps and a
  settle time (raise it if frames look blurry), and press **Start stack**.
  LensPosition is in dioptres: 0 = infinity,
  higher = closer (4 = 25 cm, 10 = 10 cm). If the lens does not move, the sweep
  stops after the first frame with an explanation — see
  [Troubleshooting](troubleshooting.md#common-problems).

Frames go to `stacks/<name>/<name>_1.tif`, `_2.tif`, …; the result is
`<name>_stacked.png`. During a stack, exposure and white balance are locked so
all frames match.

## Processing

**Stack processing** — on the Capture tab under the stack buttons, or in
Settings — decides when finished stacks are stacked:

- **When idle** (default): nothing heavy runs while you shoot. Once you have not
  captured anything, stacked or used the focus check for the idle time (5 min by
  default), all waiting stacks are processed one after another — then their
  frames are compressed and uploaded. Start shooting again and the queue pauses
  after the stack that is running. Best on a Pi 3B: the preview and captures
  stay fast.
- **Immediately**: each stack is queued right after Finish (or the sweep). You
  can keep shooting, but on a slow Pi everything gets sluggish meanwhile.
- **Manually**: stacks wait until you press **Process stack** or **Process all
  unprocessed stacks** in the Stacks tab.

A **Process stack** / **Process all** press always starts right away. Waiting
stacks show in the header as **⏸ N to stack**. Until a stack is processed its
frames stay raw TIFFs (fastest for the stacker), so they take more disk space
for a while. Stacks run one at a time; the **Jobs** tab shows progress and logs,
and each stack card its queue position.

- "Delete source frames after a successful stack" is on by default (saves
  space); if frames are uploaded as well, that happens first. Untick it to keep
  the frames, e.g. to debug a stack — **Download zip** then contains all of them.
- The stacking options are in **Settings → Stacking default options** and can be
  overridden per run in the Stacks tab.

## Halo-free stacking (default method)

Classic focus stackers (focus-stack's wavelet method) pick the frame with the
most detail per pixel. On a black backdrop the blurred rendition of a bright
edge in the defocused frames beats the featureless black of the in-focus
frame, so a glow ends up around the model. The default **halo-free** method
(`scripts/halofree-stack.py`, Python + OpenCV):

1. aligns all frames to the middle one (affine, covers focus breathing) and
   matches their brightness and colour;
2. takes the sharpest frame where one frame is clearly in focus;
3. in a band around the model takes the frame that is clearly darker there —
   next to a sharp edge that is pure black, so the glow disappears;
4. uses one fixed frame for the rest of the backdrop (no noise mosaic).

It works frame by frame (about 300 MB for 12 MP frames, so it fits a 1 GB
Pi 3B; 8 frames take 2-3 minutes there). Switch to the classic stacker with
Settings → Stacking default options → Method → `focus-stack`
([focus-stack](https://github.com/PetteriAimonen/focus-stack) is bundled).
With focus-stack, `batchsize = 0` merges all frames in one batch (best quality,
lots of RAM: on a 1 GB Pi 3B keep it at 2-4).

## Tips for sharp stacks without halos

- **Focus from the front of the model to its back, not beyond.** Frames that
  only show the velvet in front or the backdrop behind contribute nothing.
- **More frames, smaller steps** = narrower halos and more even sharpness.
- **Keep all frames identical in exposure and colour.** The automatic lock does
  this; one auto-exposed frame at half brightness was enough to cause visible
  edges.
- **Avoid blown highlights** in the single frames — a clipped white area spreads
  as a wide bright blur in the defocused frames.
- **Sharpness 0** in the camera settings.
- A thin blue/purple edge on bright contours is **lens colour fringing** — it is
  already in the single frames, not a stacking artefact.
