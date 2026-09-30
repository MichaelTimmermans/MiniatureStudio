# Cropping tall or wide models

[← Documentation](README.md)

The sensor is landscape (4:3); tall models waste the sides, wide models the top
and bottom.

1. Tick **Crop** next to the preview.
2. Pick an aspect ratio: 1:1, 4:5, 3:4, 2:3 or 9:16 for tall models; 16:9 or
   2:1 for wide ones.
3. Make the frame smaller with **Size** if needed, and drag the orange frame on
   the preview to position it (or press **Center**). A click without dragging
   still sets the focus point.

The darkened part is cut off. The grid and histogram follow the crop, and the
panel shows the final photo size (e.g. 2282 × 3040 px for 3:4 on the HQ camera).

Photos, stack frames and lens sweeps are cut to that frame when they are
captured; all frames of a stack get the same crop. Cropping costs the Pi
nothing — it even makes saving, compressing and stacking faster (a 3:4 crop
removes about 44 % of the pixels). The crop is stored on the Pi, so it applies
from every device, and it is recorded in each photo's `.json` file. Videos are
not cropped.
