"""
objects.py - per-object colour clocks.

Every frame is split into "objects": areas enclosed by colour edges (a caption, a face,
a logo, a patch of background). Each object gets its own colour clock: its own starting
hue, spin speed and direction. Objects are followed from frame to frame by overlap, so
an object's clock keeps running smoothly while it moves.

Used by mosh.py when Acid colour has "objects" switched on. Needs numpy + OpenCV.
"""
import subprocess

import cv2
import numpy as np

ANALYSIS_WIDTH = 320          # objects are found on a small copy (fast, less noise)
MIN_AREA_FRAC = 0.0006        # smaller specks join the background clock
RATES = np.array([1.0, -1.6, 2.3, -0.7, 1.4, -2.6, 0.8, -1.2, 2.9, -2.0], np.float32)
NEON = np.array([[0.9, 0.0, 0.4], [0.0, 0.55, 0.25], [0.35, 0.0, 1.15]], np.float32)


class ObjectClocks:
    """Finds objects in each frame and keeps one colour clock per object."""

    def __init__(self, detail=5, seed=1):
        d = max(1, min(10, int(detail)))
        # more detail = smaller colour differences count as an object border
        self.lo, self.hi = 120 - d * 10, 220 - d * 15
        self.rng = np.random.default_rng(seed)
        self.prev = None                       # previous label map (small)
        self.phase = np.zeros(1, np.float32)   # per previous label: start angle
        self.rate = np.ones(1, np.float32)     # per previous label: speed multiplier

    def find(self, rgb):
        """Label map (small, uint16) of the objects in one frame. 0 = background."""
        h, w = rgb.shape[:2]
        sw = min(ANALYSIS_WIDTH, w)
        sh = max(1, round(h * sw / w))
        small = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (3, 3), 0)
        lab = cv2.cvtColor(small, cv2.COLOR_RGB2LAB)
        edges = np.zeros((sh, sw), np.uint8)
        for c in range(3):                     # colour edges: lightness OR hue changes
            edges |= cv2.Canny(lab[:, :, c], self.lo, self.hi)
        edges = cv2.dilate(edges, np.ones((2, 2), np.uint8))
        n, labels = cv2.connectedComponents((edges == 0).astype(np.uint8), connectivity=4)
        labels = labels.astype(np.int32)
        # tiny pieces -> background (0)
        area = np.bincount(labels.ravel(), minlength=n)
        small_ids = area < max(4, MIN_AREA_FRAC * sw * sh)
        small_ids[0] = True
        labels[small_ids[labels]] = 0
        # renumber 1..k and let objects grow over their edge pixels
        keep = np.flatnonzero(~small_ids)
        remap = np.zeros(n, np.int32)
        remap[keep] = np.arange(1, len(keep) + 1)
        labels = remap[labels].astype(np.uint16)
        for _ in range(2):
            grown = cv2.dilate(labels, np.ones((3, 3), np.uint8))
            holes = labels == 0
            labels[holes] = grown[holes]
        return labels

    def track(self, labels):
        """Give each object a clock, inheriting it from the object it overlaps most last frame."""
        k = int(labels.max()) + 1
        phase = self.rng.uniform(0, 360, k).astype(np.float32)
        rate = self.rng.choice(RATES, k).astype(np.float32)
        phase[0], rate[0] = 0.0, 1.0
        if self.prev is not None and self.prev.shape == labels.shape:
            p = int(self.prev.max()) + 1
            pair = labels.astype(np.int64) * p + self.prev
            counts = np.bincount(pair.ravel(), minlength=k * p)
            nz = np.flatnonzero(counts)
            cur, old, val = nz // p, nz % p, counts[nz]
            order = np.lexsort((-val, cur))     # per current object: biggest overlap first
            first = np.ones(len(order), bool)
            first[1:] = cur[order][1:] != cur[order][:-1]
            best = order[first]
            area = np.bincount(labels.ravel(), minlength=k)
            ok = (old[best] > 0) & (val[best] >= 0.3 * area[cur[best]]) & (cur[best] > 0)
            ci, oi = cur[best][ok], old[best][ok]
            phase[ci] = self.phase[oi]
            rate[ci] = self.rate[oi]
        self.prev, self.phase, self.rate = labels, phase, rate
        return phase, rate


class ColorClocks:
    """One colour clock per colour family: everything that was originally the same colour
    cycles together; different colours cycle on their own speed, direction and start.

    The hue wheel is split into `families` slices (reds, yellows, greens, ...); grey-ish
    pixels get their own families by brightness (darks, mids, lights). No tracking needed:
    a colour keeps its clock wherever it appears.
    """

    def __init__(self, families=6):
        self.k = max(3, min(12, int(families)))
        total = self.k + 3                                    # + darks, mids, lights
        self.phase = (np.arange(total, dtype=np.float32) * (360.0 / total) * 7) % 360
        self.rate = np.resize(RATES, total).astype(np.float32)

    def find(self, rgb):
        hsv = cv2.cvtColor(cv2.medianBlur(rgb, 5), cv2.COLOR_RGB2HSV)
        h, s, v = hsv[:, :, 0].astype(np.int32), hsv[:, :, 1], hsv[:, :, 2]
        fam = ((h * self.k + 90 // self.k) // 180) % self.k  # hue slice (H is 0..179)
        grey = (s < 50) | (v < 40)
        fam = np.where(grey, self.k + np.minimum(v.astype(np.int32) // 86, 2), fam)
        return fam.astype(np.uint16)

    def track(self, labels):
        return self.phase, self.rate


def style_frame(rgb, color):
    """Contrast / brightness / style before the clocks turn the hues."""
    f = rgb.astype(np.float32)
    f = (f - 128.0) * float(color.get("contrast", 1.0)) + 128.0 + 255.0 * float(color.get("brightness", 0.0))
    out = np.clip(f, 0, 255).astype(np.uint8)
    if color.get("style") == "prism":
        gray = cv2.cvtColor(out, cv2.COLOR_RGB2GRAY)
        out = cv2.cvtColor(cv2.applyColorMap(gray, cv2.COLORMAP_RAINBOW), cv2.COLOR_BGR2RGB)
    return out


def finish_frame(rgb, color):
    """Neon tint and posterize after the clocks."""
    out = rgb
    if color.get("neon"):
        out = np.clip(out.astype(np.float32) @ NEON.T, 0, 255).astype(np.uint8)
    levels = int(color.get("posterize", 0) or 0)
    if color.get("style") == "pure" and levels < 2:
        levels = 3
    if levels >= 2:
        step = 256 // levels
        top = 255 // (levels - 1)
        out = ((out // step).clip(0, levels - 1) * top).astype(np.uint8)
    return out


def process(ffmpeg, src, dst, fps, w, h, color, joins=(), soften=False, deblock="",
            cancelled=lambda: False, creationflags=0, raw_m4v=True):
    """Decode the moshed stream, colour every object with its own clock, write ProRes."""
    rate = f"{fps.numerator}/{fps.denominator}"
    vf = ["-vf", deblock] if soften and deblock else []
    src_args = ["-framerate", rate, "-f", "m4v", "-i", str(src)] if raw_m4v else ["-i", str(src)]
    reader = subprocess.Popen([ffmpeg, "-v", "error", *src_args,
                               *vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                              stdout=subprocess.PIPE, stdin=subprocess.DEVNULL,
                              creationflags=creationflags)
    writer = subprocess.Popen([ffmpeg, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                               "-s", f"{w}x{h}", "-framerate", rate, "-i", "-",
                               "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                               str(dst)],
                              stdin=subprocess.PIPE, creationflags=creationflags)
    if color.get("clock") == "objects":
        clocks = ObjectClocks(detail=color.get("detail", 5))
    else:
        clocks = ColorClocks(families=color.get("families", 6))
    sat = float(color.get("sat", 1.0))
    spin = float(color.get("spin", 0.0))
    jump = float(color.get("hue_jump", 0.0))
    joins = sorted(joins)
    size = w * h * 3
    n = 0
    try:
        while True:
            if cancelled():
                raise RuntimeError("cancelled")
            buf = reader.stdout.read(size)
            if len(buf) < size:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            labels = clocks.find(frame)                     # objects in the ORIGINAL colours
            phase, rate_ = clocks.track(labels)
            cuts_passed = int(np.searchsorted(joins, n, side="right"))
            angle = (phase + n * spin * rate_ + cuts_passed * jump) % 360.0
            full = labels if labels.shape[:2] == (h, w) else \
                cv2.resize(labels, (w, h), interpolation=cv2.INTER_NEAREST)
            styled = style_frame(frame, color)
            hsv = cv2.cvtColor(styled, cv2.COLOR_RGB2HSV)   # H is 0..179
            shift = (angle / 2.0).astype(np.float32)[full]
            hsv[:, :, 0] = ((hsv[:, :, 0].astype(np.float32) + shift) % 180).astype(np.uint8)
            hsv[:, :, 1] = np.clip(hsv[:, :, 1].astype(np.float32) * sat, 0, 255).astype(np.uint8)
            out = finish_frame(cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB), color)
            writer.stdin.write(out.tobytes())
            n += 1
    finally:
        try:
            writer.stdin.close()
        except OSError:
            pass
        reader.kill()
        reader.wait()
        writer.wait()
    if writer.returncode != 0:
        raise RuntimeError("ffmpeg could not write the coloured clip")
    return n
