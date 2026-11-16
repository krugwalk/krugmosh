"""
target.py - targeted datamosh: mosh only one object and the trail it leaves.

1. pick:  find objects in one frame (sensitivity = how finely to split by colour edges);
          the user clicks the object (one or more pieces) and confirms.
2. track: follow that object through the clip: its mask is moved along the motion
          (optical flow) and snapped to the colour edges of each new frame.
3. mosh:  inside the object (and the trail it leaves) the picture is built the way a
          datamosh builds it: the previous output frame's pixels are dragged along the
          motion in square blocks (motion-only P-frames, no fresh picture). The trail
          keeps moshing and slowly fades back to the real picture. Outside: untouched.

Needs numpy + OpenCV (same as objects.py). The clip keeps its timing.
"""
import subprocess

import cv2
import numpy as np

from objects import ObjectClocks

PICK_WIDTH = 480          # size of the picture shown in the panel for picking


# ------------------------------------------------------------------------ picking

def segment(rgb, sensitivity):
    """Object label map (small) for one frame; 0 = background / specks."""
    return ObjectClocks(detail=sensitivity).find(rgb)


def label_at(labels, x, y):
    """Object under a click (x, y in 0..1). Clicking an edge picks the nearest object."""
    h, w = labels.shape
    cx, cy = min(w - 1, max(0, int(x * w))), min(h - 1, max(0, int(y * h)))
    if labels[cy, cx]:
        return int(labels[cy, cx])
    for r in range(1, 12):                         # look around a little
        win = labels[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
        nz = win[win > 0]
        if nz.size:
            return int(np.bincount(nz).argmax())
    return 0


def overlay(rgb, labels, selected):
    """Picture for the panel: thin outlines around every object, chosen ones lit up."""
    h, w = rgb.shape[:2]
    ow, oh = PICK_WIDTH, max(1, round(h * PICK_WIDTH / w))
    img = cv2.resize(rgb, (ow, oh), interpolation=cv2.INTER_AREA).astype(np.float32)
    lab = cv2.resize(labels, (ow, oh), interpolation=cv2.INTER_NEAREST)
    edge = (lab != np.roll(lab, 1, 0)) | (lab != np.roll(lab, 1, 1))
    img[edge] = img[edge] * 0.35 + 255 * 0.65
    if selected:
        m = np.isin(lab, list(selected))
        img[m] = img[m] * 0.45 + np.array([255, 40, 200], np.float32) * 0.55
        sel_edge = m & ~cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        img[sel_edge] = (25, 230, 255)
    return np.clip(img, 0, 255).astype(np.uint8)


def mask_from(labels, selected):
    return np.isin(labels, list(selected)).astype(np.float32)


# ------------------------------------------------------ magic-wand picking (used by the panel)

WAND_WIDTH = 320


def wand_prep(rgb):
    """Small, smoothed copy for the wand: thin lines (fences, wires) and noise melt away."""
    h, w = rgb.shape[:2]
    sw = min(WAND_WIDTH, w)
    small = cv2.resize(rgb, (sw, max(1, round(h * sw / w))), interpolation=cv2.INTER_AREA)
    return cv2.medianBlur(small, 7)


def wand(prep, points, sensitivity, limit=None):
    """Grow a selection from clicked points through similar colours.

    sensitivity 1..10: how different a neighbouring colour may be and still join
    (higher = grabs more). limit: optional mask the selection may not leave.
    """
    tol = 8 + int(sensitivity) * 7                 # 1 -> 15 (strict) ... 10 -> 78 (loose)
    h, w = prep.shape[:2]
    sel = np.zeros((h, w), np.uint8)
    for x, y in points:
        px, py = min(w - 1, max(0, int(x * w))), min(h - 1, max(0, int(y * h)))
        ff = np.zeros((h + 2, w + 2), np.uint8)
        if limit is not None:
            ff[1:-1, 1:-1] = (limit == 0)          # flood fill can't cross non-zero mask pixels
        img = prep.copy()
        # FIXED_RANGE: compare with the CLICKED colour, not the neighbour, so the fill
        # stops where the object's colour ends instead of creeping across gradients
        cv2.floodFill(img, ff, (px, py), (0, 0, 0), (tol,) * 3, (tol,) * 3,
                      4 | cv2.FLOODFILL_FIXED_RANGE | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
        sel |= (ff[1:-1, 1:-1] == 255)
    # tidy: close small gaps, fill pinholes
    sel = cv2.morphologyEx(sel, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return sel.astype(np.float32)


def wand_overlay(rgb, sel):
    """Panel picture: the selection lit up in magenta with a cyan outline."""
    h, w = rgb.shape[:2]
    ow, oh = PICK_WIDTH, max(1, round(h * PICK_WIDTH / w))
    img = cv2.resize(rgb, (ow, oh), interpolation=cv2.INTER_AREA).astype(np.float32)
    m = cv2.resize(sel, (ow, oh), interpolation=cv2.INTER_NEAREST) > 0.5
    img[m] = img[m] * 0.45 + np.array([255, 40, 200], np.float32) * 0.55
    edge = m & ~cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    img[edge] = (25, 230, 255)
    return np.clip(img, 0, 255).astype(np.uint8)


class WandTracker:
    """Moves the selection along the motion, then regrows it from inside with the wand
    (limited to just around the moved mask) so it keeps hugging the object."""

    def __init__(self, mask, sensitivity):
        self.mask = mask.astype(np.float32)
        self.sens = sensitivity

    def step(self, rgb_small_prep, flow_back):
        h, w = self.mask.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        warped = cv2.remap(self.mask, gx + flow_back[..., 0], gy + flow_back[..., 1],
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0.5
        if not warped.any():
            self.mask = warped.astype(np.float32)
            return self.mask
        # seeds: a few points well inside the moved mask
        core = cv2.erode(warped.astype(np.uint8), np.ones((5, 5), np.uint8))
        ys, xs = np.nonzero(core if core.any() else warped)
        idx = np.linspace(0, len(xs) - 1, min(12, len(xs))).astype(int)
        pts = [(xs[i] / w, ys[i] / h) for i in idx]
        limit = cv2.dilate(warped.astype(np.uint8), np.ones((9, 9), np.uint8))
        grown = wand(rgb_small_prep, pts, self.sens, limit=limit) > 0.5
        a_w, a_g = warped.sum(), grown.sum()
        self.mask = (grown if 0.6 * a_w <= a_g <= 1.5 * a_w else warped).astype(np.float32)
        return self.mask


# ----------------------------------------------------------------------- tracking

class Tracker:
    """Moves the object mask along the motion and snaps it to each frame's colour edges."""

    def __init__(self, mask, sensitivity):
        self.mask = mask.astype(np.float32)        # small, 0..1
        self.sens = sensitivity
        self.prev_gray = None

    def step(self, rgb_small, flow_back):
        h, w = self.mask.shape
        gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        warped = cv2.remap(self.mask, gx + flow_back[..., 0], gy + flow_back[..., 1],
                           cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        # snap to this frame's objects: keep the pieces that mostly sit inside the moved mask
        labels = segment(rgb_small, self.sens)
        if labels.shape != warped.shape:
            labels = cv2.resize(labels, (w, h), interpolation=cv2.INTER_NEAREST)
        inside = warped > 0.5
        k = int(labels.max()) + 1
        area = np.bincount(labels.ravel(), minlength=k)
        hit = np.bincount(labels[inside].ravel(), minlength=k)
        keep = np.flatnonzero((hit >= 0.5 * np.maximum(area, 1)) & (np.arange(k) > 0))
        snapped = np.isin(labels, keep).astype(np.float32)
        a_w, a_s = inside.sum(), snapped.sum()
        # trust the snap only when it agrees with the motion (no sudden grow / shrink)
        self.mask = snapped if a_w and 0.6 * a_w <= a_s <= 1.6 * a_w else (warped > 0.5).astype(np.float32)
        return self.mask


# --------------------------------------------------------------------------- effect

def block_flow(flow_small, w, h, block):
    """Full-size flow, averaged per square block (macroblock motion, like a codec)."""
    sx, sy = w / flow_small.shape[1], h / flow_small.shape[0]
    fx = cv2.resize(flow_small[..., 0], (w, h)) * sx
    fy = cv2.resize(flow_small[..., 1], (w, h)) * sy
    bw, bh = max(1, w // block), max(1, h // block)
    fx = cv2.resize(cv2.resize(fx, (bw, bh), interpolation=cv2.INTER_AREA), (w, h),
                    interpolation=cv2.INTER_NEAREST)
    fy = cv2.resize(cv2.resize(fy, (bw, bh), interpolation=cv2.INTER_AREA), (w, h),
                    interpolation=cv2.INTER_NEAREST)
    return fx, fy


def mosh_frame(frame, prev_out, gray, prev_gray, prep, alpha, tracker, gx, gy, w, h, block,
               decay, refresh):
    """One tracked frame: move the mask, drag old pixels inside it, carry the trail."""
    # motion from this frame back to the previous one (where each pixel came from)
    flow_back = cv2.calcOpticalFlowFarneback(gray, prev_gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    mask = tracker.step(prep, flow_back)
    fx, fy = block_flow(flow_back, w, h, block)
    mx, my = gx + fx, gy + fy
    # datamosh: old pixels dragged along this frame's motion, block by block
    dragged = cv2.remap(prev_out, mx, my, cv2.INTER_NEAREST, borderMode=cv2.BORDER_REPLICATE)
    obj = cv2.GaussianBlur(cv2.resize(mask, (w, h)), (0, 0), 2)
    carried = cv2.remap(alpha, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                        borderValue=0) * decay
    alpha = np.maximum(obj, carried)
    a = alpha[..., None]
    moshed = dragged.astype(np.float32) * (1 - refresh) + frame.astype(np.float32) * refresh
    out = (a * moshed + (1 - a) * frame.astype(np.float32)).astype(np.uint8)
    return out, alpha


def scale_vf(w, h, fps, fmt="rgb24"):
    """Same framing as the mosh encode: fit into w x h, pad, fixed frame rate."""
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,"
            f"setsar=1,fps={fps.numerator}/{fps.denominator},format={fmt}")


def grab_frame(ffmpeg, clip, offset, w, h, fps, creationflags=0):
    """One frame of a clip, `offset` seconds in, as RGB (w x h)."""
    start = float(clip.get("start") or 0) + max(0.0, float(offset))
    r = subprocess.run([ffmpeg, "-v", "error", "-ss", f"{start:.6f}", "-i", str(clip["path"]),
                        "-frames:v", "1", "-vf", scale_vf(w, h, fps), "-f", "rawvideo",
                        "-pix_fmt", "rgb24", "-"], capture_output=True, stdin=subprocess.DEVNULL,
                       creationflags=creationflags)
    if r.returncode or len(r.stdout) < w * h * 3:
        raise ValueError("couldn't read a frame from the clip at that point")
    return np.frombuffer(r.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)


def run(ffmpeg, clip, dst, fps, w, h, seed_mask, start_frame, sensitivity=5, trail=30,
        block=16, refresh=0.03, log=print, cancelled=lambda: False, creationflags=0,
        vf_scale=""):
    """Render the targeted mosh of one clip to ProRes (same length as the clip)."""
    rate = f"{fps.numerator}/{fps.denominator}"
    rng = []
    if clip.get("start"):
        rng += ["-ss", f"{clip['start']:.6f}"]
    if clip.get("duration"):
        rng += ["-t", f"{clip['duration']:.6f}"]
    reader = subprocess.Popen([ffmpeg, "-v", "error", *rng, "-i", str(clip["path"]), "-an",
                               "-vf", vf_scale, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                              stdout=subprocess.PIPE, stdin=subprocess.DEVNULL,
                              creationflags=creationflags)
    writer = subprocess.Popen([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                               "-s", f"{w}x{h}", "-framerate", rate, "-i", "-",
                               "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                               str(dst)], stdin=subprocess.PIPE, creationflags=creationflags)
    sw = seed_mask.shape[1]
    sh = seed_mask.shape[0]
    tracker = WandTracker(seed_mask, sensitivity)
    decay = 0.0 if trail <= 0 else float(np.exp(-1.0 / trail))
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    prev_out = prev_gray = alpha = None
    failed_once = False
    n = 0
    size = w * h * 3
    try:
        while True:
            if cancelled():
                raise RuntimeError("cancelled")
            buf = reader.stdout.read(size)
            if len(buf) < size:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            small = cv2.resize(frame, (sw, sh), interpolation=cv2.INTER_AREA)
            gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
            prep = cv2.medianBlur(small, 7)                 # same smoothing as the wand
            if n < start_frame:
                out = frame.copy()                        # before the picked frame: untouched
            elif alpha is None:
                out = frame.copy()                        # the picked frame: tracking starts here
                alpha = cv2.resize(tracker.mask, (w, h))
            else:
                try:
                    out, alpha = mosh_frame(frame, prev_out, gray, prev_gray, prep, alpha, tracker,
                                            gx, gy, w, h, block, decay, refresh)
                except cv2.error as e:
                    # one bad frame (e.g. a sudden cut) mustn't kill the whole render
                    out = frame.copy()
                    if not failed_once:
                        log(f"  (frame {n}: tracking hiccup, passed through: {str(e)[:80]})")
                        failed_once = True
            writer.stdin.write(out.tobytes())
            prev_out, prev_gray = out, gray
            n += 1
            if n % 60 == 0:
                log(f"  targeted mosh: {n} frames")
    finally:
        try:
            writer.stdin.close()
        except OSError:
            pass
        reader.kill()
        reader.wait()
        writer.wait()
    if writer.returncode != 0:
        raise RuntimeError("ffmpeg could not write the targeted mosh")
    return n
