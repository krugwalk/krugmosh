#!/usr/bin/env python3
"""
mosh.py - Avidemux-style datamosh transition, automated.

Reproduces the manual Avidemux workflow:
  1. Append clips and encode as MPEG-4 ASP (Xvid) with 0 B-frames, GOP max 999.
  2. In "copy" mode, delete every I-frame except the very first one.
  3. Optionally delete a few frames around each join.
  4. Save. (Here we also convert the result to ProRes so editors play it reliably.)

Usage:
  python mosh.py clipA.mp4 clipB.mp4 -o moshed.mov
  python mosh.py a.mp4 b.mp4 c.mp4 -o out.mov --trim-a 2 --trim-b 3 --avi out.avi
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from fractions import Fraction
from pathlib import Path

START = b"\x00\x00\x01"
VOP_CODE = 0xB6
VOP_TYPES = {0: "I", 1: "P", 2: "B", 3: "S"}


# --------------------------------------------------------------------------- tools

def find_tool(name, folder=None):
    exe = name + (".exe" if os.name == "nt" else "")
    if folder:
        p = Path(folder) / exe
        if p.exists():
            return str(p)
        sys.exit(f"{exe} not found in {folder}")
    found = shutil.which(name)
    if found:
        return found
    if os.name == "nt":  # winget installs ffmpeg here without needing a new shell
        root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
        for p in root.glob(f"Gyan.FFmpeg*/*/bin/{exe}"):
            return str(p)
    sys.exit(f"Could not find {name}. Install ffmpeg or pass --ffmpeg-dir.")


class Cancelled(Exception):
    pass


# Per-thread cancel flag: mosh_clips(cancel=event) sets it, run() honours it.
_ctx = threading.local()


def check_cancel():
    ev = getattr(_ctx, "cancel", None)
    if ev is not None and ev.is_set():
        raise Cancelled("cancelled")


def run(cmd):
    check_cancel()
    # CREATE_NO_WINDOW: when the helper runs hidden, ffmpeg mustn't flash console windows.
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            stdin=subprocess.DEVNULL, text=True, creationflags=flags)
    while True:
        try:
            out, err = proc.communicate(timeout=0.25)
            break
        except subprocess.TimeoutExpired:
            ev = getattr(_ctx, "cancel", None)
            if ev is not None and ev.is_set():
                proc.kill()
                proc.communicate()
                raise Cancelled("cancelled")
    if proc.returncode != 0:
        sys.exit(f"Command failed:\n  {' '.join(cmd)}\n{err.strip()}")
    return out


def probe(ffprobe, path):
    out = run([ffprobe, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", str(path)])
    streams = json.loads(out).get("streams")
    if not streams:
        sys.exit(f"{path}: no video stream")
    s = streams[0]
    return int(s["width"]), int(s["height"]), Fraction(s["r_frame_rate"])


# ------------------------------------------------------------------ encode / decode

def encode_xvid(ffmpeg, src, dst, w, h, fps, quant, start=None, duration=None, force_key=None,
                gop=999):
    """Step 1: Xvid, 0 B-frames, GOP max 999 (same settings as the tutorial).

    force_key: list of frame numbers that must be keyframes (used to "heal" a mosh).
    gop: longest allowed gap between keyframes (999 = only at scene changes).
    """
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
          f"fps={fps.numerator}/{fps.denominator},format=yuv420p")
    rng = []
    if start:
        rng += ["-ss", f"{start:.6f}"]
    if duration:
        rng += ["-t", f"{duration:.6f}"]
    fk = []
    if force_key:
        fk = ["-force_key_frames", "expr:" + "+".join(f"eq(n,{n})" for n in sorted(force_key))]
    run([ffmpeg, "-y", "-v", "error", *rng, "-i", str(src), "-an", "-vf", vf,
         "-c:v", "libxvid", "-q:v", str(quant), "-bf", "0", "-g", str(int(gop)), *fk,
         *FINE_MOTION, "-f", "m4v", str(dst)])


# Quarter-pixel motion, 4 vectors per block and the most careful motion search: smoother,
# more accurate motion, so smears and blooms flow instead of stepping in hard blocks.
# Every clip in one mosh must share these (quarter-pixel is a stream-wide setting).
FINE_MOTION = ["-flags", "+qpel+mv4", "-me_quality", "6"]
ENCODE_VERSION = 2   # bump when encoder settings change, so old cached encodes aren't reused

# Softens block edges the way players (Avidemux, VLC) do when showing Xvid.
DEBLOCK = "deblock=filter=strong:block=8:alpha=0.15:beta=0.1:gamma=0.1:delta=0.1"


CACHE_DIR = Path(tempfile.gettempdir()) / "datamosh_cache"
CACHE_MAX_AGE = 24 * 3600


def clean_cache():
    """Delete cached encodes older than a day."""
    if not CACHE_DIR.exists():
        return
    now = time.time()
    for f in CACHE_DIR.glob("*.m4v"):
        try:
            if now - f.stat().st_mtime > CACHE_MAX_AGE:
                f.unlink()
        except OSError:
            pass


def encode_cached(ffmpeg, clip, w, h, fps, quant, force_key=None, gop=999):
    """Encode a clip to Xvid, reusing an earlier identical encode (e.g. from a scan)."""
    src = Path(clip["path"])
    st = src.stat()
    key = json.dumps([str(src.resolve()), st.st_size, st.st_mtime, clip.get("start"),
                      clip.get("duration"), w, h, str(fps), quant,
                      sorted(force_key or []), int(gop), ENCODE_VERSION])
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest()[:20] + ".m4v")
    if out.exists() and out.stat().st_size > 0:
        out.touch()
        return out, True
    part = out.with_suffix(".part")
    encode_xvid(ffmpeg, src, part, w, h, fps, quant, clip.get("start"), clip.get("duration"),
                force_key, gop)
    part.replace(out)
    return out, False


def color_filter(color, joins):
    """Acid colour as an ffmpeg filter chain.

    color: {"style": "prism" | "pure" | "tint",
            "sat": 3.0 (up to 10), "contrast": 1.5, "brightness": 0.0 (-0.5..0.5),
            "spin": degrees per frame the colours rotate (a fast "clock" through the wheel),
            "hue_jump": extra degrees at every cut, "neon": bool, "posterize": levels (0 = off)}
      prism: brightness is mapped onto a rainbow first, so every frame holds many pure colours
      pure:  saturation pushed until areas clip to pure primaries (posterized to 3 levels)
      tint:  the plain picture, saturated
    joins: output frame numbers where cuts are (for hue_jump).
    """
    style = color.get("style", "tint")
    pre = (f"eq=contrast={float(color.get('contrast', 1)):.3f}:"
           f"brightness={float(color.get('brightness', 0)):.3f}")
    # Saturation through the hue filter: eq caps it at 3x, hue goes up to 10x.
    sat = max(0.0, min(10.0, float(color.get("sat", 1))))
    spin = float(color.get("spin", 0))
    jump = float(color.get("hue_jump", 0))
    jump_term = ""
    if jump and joins:
        seg = "+".join(f"gte(n,{j})" for j in joins)          # how many cuts we're past
        jump_term = f"({seg})*{jump:.3f}"

    def hue(rate=1.0, phase=0.0):
        terms = [t for t in (f"n*{spin * rate:.3f}" if spin else "",
                             f"{phase:.1f}" if phase else "", jump_term) if t]
        return f"hue=s={sat:.3f}" + (":h='" + "+".join(terms) + "'" if terms else "")

    post = []
    if color.get("neon"):
        # pull everything towards purple / magenta / blue
        post.append("colorchannelmixer=rr=0.9:rb=0.4:gg=0.55:gb=0.25:bb=1.15:br=0.35")
    levels = int(color.get("posterize", 0) or 0)
    if style == "pure" and levels < 2:
        levels = 3
    if levels >= 2:
        step = max(1, 256 // levels)
        post.append(f"lutrgb=r='floor(val/{step})*{step}':g='floor(val/{step})*{step}':"
                    f"b='floor(val/{step})*{step}'")
    prism = "pseudocolor=preset=spectral," if style == "prism" else ""

    regions = int(color.get("regions", 0) or 0)
    if regions < 2:
        return ",".join([pre, prism + hue()] + post)

    # Regions: split the picture by brightness into bands (borders follow the shapes in
    # the shot); every band cycles the colour wheel at its own speed, direction and
    # starting point, so different areas show different, independently turning colours.
    k = min(8, regions)
    rates = [1.0, -1.7, 2.4, -0.6, 1.3, -2.9, 0.8, -1.2]
    # region 0 is the base layer; regions 1..k-1 are laid over it through their masks
    # (format fixed to yuv444p before the split: otherwise ffmpeg may pick grey for BOTH
    # branches and the colour branch loses its colour; the masks take only the Y plane)
    # histeq first: brightness evened out so every region covers a similar share of the frame
    masks = "[dm_l]histeq=strength=1:intensity=1,format=yuv444p,extractplanes=y" + (
        f",split={k - 1}" + "".join(f"[dm_g{i}]" for i in range(1, k)) if k > 2 else "[dm_g1]")
    g = [f"{pre},format=yuv444p,split=2[dm_l][dm_c]", masks,
         f"[dm_c]{prism}format=yuv444p,split={k}" + "".join(f"[dm_c{i}]" for i in range(k))]
    for i in range(k):
        if i:
            lo, hi = i * 256 // k, (i + 1) * 256 // k - 1
            g.append(f"[dm_g{i}]lut=c0='if(between(val,{lo},{hi}),255,0)',format=gbrp[dm_k{i}]")
        g.append(f"[dm_c{i}]{hue(rates[i], i * 360.0 / k)},format=gbrp[dm_h{i}]")
    acc = "dm_h0"
    for i in range(1, k):
        nxt = f"dm_a{i}"
        g.append(f"[{acc}][dm_h{i}][dm_k{i}]maskedmerge[{nxt}]")
        acc = nxt
    # packed RGB before the neon / posterize steps (they misread the planar merge output)
    g.append(f"[{acc}]" + ",".join(["format=rgb24"] + post + ["format=yuv444p"]))
    return ";".join(g)


def decode_to_prores(ffmpeg, src, dst, fps, soften=False, color=None, joins=(), size=None):
    if color and color.get("objects") and size:
        # Per-object colour clocks: frames go through Python (objects.py).
        try:
            import objects
        except ImportError as e:
            sys.exit(f"Object colours need numpy and OpenCV ({e}). "
                     f"Run: python -m pip install numpy opencv-python-headless")
        ev = getattr(_ctx, "cancel", None)
        try:
            objects.process(ffmpeg, src, dst, fps, size[0], size[1], color, joins=joins,
                            soften=soften, deblock=DEBLOCK,
                            cancelled=lambda: ev is not None and ev.is_set(),
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except RuntimeError as e:
            if ev is not None and ev.is_set():
                raise Cancelled("cancelled")
            sys.exit(str(e))
        return
    chain = ([DEBLOCK] if soften else []) + ([color_filter(color, list(joins))] if color else [])
    vf = ["-vf", ",".join(chain)] if chain else []
    run([ffmpeg, "-y", "-v", "error", "-framerate", f"{fps.numerator}/{fps.denominator}",
         "-f", "m4v", "-i", str(src), *vf,
         "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", str(dst)])


def make_preview(ffmpeg, video, join, total, dst, thumb_w=160):
    """A 4x2 strip of frames around the cut: before, at, and after."""
    offsets = [-3, -1, 0, 2, 5, 9, 15, 24]
    picks = sorted({min(max(join + o, 0), total - 1) for o in offsets})
    sel = "+".join(f"eq(n,{n})" for n in picks)  # commas are safe inside '...'
    run([ffmpeg, "-y", "-v", "error", "-i", str(video),
         "-vf", f"select='{sel}',scale={thumb_w}:-2,tile=4x2:padding=2:color=black",
         "-frames:v", "1", "-fps_mode", "passthrough", str(dst)])
    return [n - join for n in picks]


def remux_avi(ffmpeg, src, dst, fps):
    """Moshed stream in an AVI, untouched (open it in Avidemux to compare)."""
    run([ffmpeg, "-y", "-v", "error", "-framerate", f"{fps.numerator}/{fps.denominator}",
         "-f", "m4v", "-i", str(src), "-c:v", "copy", "-vtag", "XVID", str(dst)])


# ------------------------------------------------------------------ bitstream editing

def split_frames(data):
    """Split an MPEG-4 Part 2 elementary stream into frames.

    Each frame is one VOP (start code 00 00 01 B6) plus any headers (VOS/VOL/GOV/
    user data) that come right before it. Returns a list of (type, bytes).
    """
    begins, types = [], []
    pending = None
    pos = data.find(START)
    while pos != -1 and pos + 4 < len(data):
        code = data[pos + 3]
        if code == VOP_CODE:
            begins.append(pending if pending is not None else pos)
            types.append(VOP_TYPES[data[pos + 4] >> 6])
            pending = None
        elif pending is None:
            pending = pos
        pos = data.find(START, pos + 3)
    if not begins:
        raise ValueError("no MPEG-4 frames found")
    begins[0] = 0
    ends = begins[1:] + [len(data)]
    return [(t, data[b:e]) for t, b, e in zip(types, begins, ends)]


def heal_frame(trim_b, heal_after):
    """Clip-local frame number to turn back into a keyframe, `heal_after` frames after the cut."""
    return 1 + trim_b + heal_after if heal_after > 0 else None


def plan_drops(clips, fps, mode="auto", only_joins=False, cuts=None, heal_after=0, trim_b=0,
               keyframes=None, frame_range=None, timeline_starts=None):
    """Decide which keyframes to delete. Returns a set of (clip_index, frame_index).

    mode "auto":   every keyframe after the very first (or only the ones at cuts with
                   only_joins), optionally limited to frame_range=(start_s, end_s) on the timeline.
    mode "manual": exactly the keyframes listed in `keyframes` ([[clip, frame], ...]).
    Always kept: the very first frame, keyframes at disabled cuts, and heal keyframes.
    """
    cuts = cuts or []
    wanted = {(int(c), int(f)) for c, f in (keyframes or [])}
    starts, acc = [], 0
    for frames in clips:
        starts.append(acc / float(fps))
        acc += len(frames)
    if timeline_starts:
        starts = [float(t) for t in timeline_starts]

    drops = set()
    for ci, frames in enumerate(clips):
        cut_on = ci == 0 or (cuts[ci - 1] if ci - 1 < len(cuts) else True)
        heal = heal_frame(trim_b, heal_after) if ci > 0 and cut_on else None
        for fi, (ftype, _) in enumerate(frames):
            if ftype != "I" or (ci == 0 and fi == 0):
                continue
            if fi == 0 and not cut_on:
                continue          # hard cut: keep the incoming clip's keyframe
            if fi == heal:
                continue          # heal point: keep so the picture snaps back clean
            if mode == "manual":
                if (ci, fi) in wanted:
                    drops.add((ci, fi))
                continue
            if only_joins and fi != 0:
                continue
            if frame_range:
                t = starts[ci] + fi / float(fps)
                if not (frame_range[0] - 1e-6 <= t <= frame_range[1] + 1e-6):
                    continue
            drops.add((ci, fi))
    return drops


def bloom_frame(trim_b, bloom_at):
    """Clip-local frame number where a bloom starts, `bloom_at` frames after the cut."""
    return 1 + trim_b + bloom_at


BLOOM_WINDOW = 90       # auto-pick looks this many frames past the cut
BLOOM_SMOOTH_QUANT = 16  # quality of the repeated frame in smooth bloom (higher = fewer colour corrections)


def pick_bloom_frame(frames, ci, start, drops=(), auto=True, window=BLOOM_WINDOW):
    """Which motion frame to repeat.

    auto:  the frame with the strongest motion within `window` frames of `start`
           (biggest motion frame = most of the picture moving), like picking a good spot
           in Avidemux by eye.
    else:  the first motion frame at or after `start`.
    """
    end = len(frames) if not auto else min(len(frames), start + window)
    cands = [fi for fi in range(start, end) if frames[fi][0] == "P" and (ci, fi) not in drops]
    if not cands:
        return None
    return max(cands, key=lambda fi: len(frames[fi][1])) if auto else cands[0]


def smear(kept, frames_n, repeat):
    """Smear boost: repeat each of the first `frames_n` motion frames after a cut `repeat`
    times. The whole stretch of motion after the cut is replayed several times over, so the
    old picture gets dragged and churned much harder than by one mosh."""
    if frames_n <= 0 or repeat <= 1:
        return kept, 0
    out, done, added = [], 0, 0
    for fr in kept:
        out.append(fr)
        if fr[0] == "P" and done < frames_n:
            out.extend([fr] * (repeat - 1))
            added += repeat - 1
            done += 1
    return out, added


def mosh(clips, trim_a, trim_b, only_joins=False, drops=None, cuts=None, blooms=None,
         smear_frames=0, smear_repeat=1):
    """Steps 2 and 3: delete keyframes and trim around moshed cuts.

    drops: set of (clip, frame) to delete (see plan_drops). If None, the classic rule:
    every keyframe except the first (or only those at cuts with only_joins).
    blooms: {clip_index: (after_frame, [(type, payload), ...])}: frames inserted after
    `after_frame` (one motion frame, repeated), so its motion is applied over and over ("bloom").
    smear_frames / smear_repeat: smear boost after every moshed cut (see smear()).
    """
    blooms = blooms or {}
    bloomed = 0
    smeared = 0
    if drops is None:
        drops = plan_drops(clips, 1, only_joins=only_joins, cuts=cuts)
    cuts = cuts or []
    out, removed, joins, mosh_joins = [], 0, [], []
    last = len(clips) - 1
    for ci, frames in enumerate(clips):
        cut_in = ci > 0 and (cuts[ci - 1] if ci - 1 < len(cuts) else True)
        cut_out = ci < last and (cuts[ci] if ci < len(cuts) else True)
        kept = []
        bloom = blooms.get(ci)
        for fi, (ftype, payload) in enumerate(frames):
            if (ci, fi) in drops:
                removed += 1
                continue
            kept.append((ftype, payload))
            if bloom and fi == bloom[0]:
                kept.extend(bloom[1])
                bloomed += len(bloom[1])
        if cut_in and trim_b:
            kept = kept[min(trim_b, len(kept) - 1):]
        if cut_out and trim_a:
            kept = kept[:max(len(kept) - trim_a, 1)]
        if cut_in and smear_frames:
            kept, added = smear(kept, smear_frames, smear_repeat)
            smeared += added
        if ci > 0:
            joins.append(len(out))  # output frame index where this clip starts
            if cut_in:
                mosh_joins.append(len(out))
        out.extend(kept)
    mosh.last_bloomed = bloomed
    mosh.last_smeared = smeared
    return out, removed, joins, mosh_joins


# ------------------------------------------------------------------------------ main

def parse_fps(value):
    fps = value if isinstance(value, Fraction) else Fraction(str(value))
    for base in (24, 30, 48, 60, 120):  # snap 23.976 / 29.97 / 59.94 ... to exact NTSC rates
        ntsc = Fraction(base * 1000, 1001)
        if abs(float(fps) - float(ntsc)) < 0.01:
            return ntsc
    return fps.limit_denominator(1001)


def _guarded(fn, cleanup, cancel):
    """Run fn with the cancel flag set; delete `cleanup` files if cancelled."""
    _ctx.cancel = cancel
    try:
        return fn()
    except Cancelled:
        for f in cleanup:  # don't leave half-written files behind
            if f and Path(f).exists():
                try:
                    Path(f).unlink()
                except OSError:
                    pass
        raise
    finally:
        _ctx.cancel = None


def prepare(clips, quant, size, fps, log, force_keys=None, gop=999):
    """Probe, then encode every clip to Xvid (cached). Returns (ffmpeg, w, h, fps, frames, paths)."""
    ffmpeg = find_tool("ffmpeg", MOSH_FFMPEG_DIR)
    ffprobe = find_tool("ffprobe", MOSH_FFMPEG_DIR)
    clean_cache()

    w, h, src_fps = probe(ffprobe, clips[0]["path"])
    if size:
        w, h = size
    fps = parse_fps(fps) if fps else src_fps
    w, h = w - w % 2, h - h % 2

    encoded, paths = [], []
    for i, clip in enumerate(clips):
        log(f"Encoding clip {i + 1}/{len(clips)}: {Path(clip['path']).name} "
            f"-> Xvid {w}x{h} @ {float(fps):.3f} fps")
        force = (force_keys or {}).get(i)
        m4v, hit = encode_cached(ffmpeg, clip, w, h, fps, quant, force, gop)
        try:
            frames = split_frames(m4v.read_bytes())
        except ValueError:
            raise ValueError(f"clip {i + 1} ({Path(clip['path']).name}) produced no frames: "
                             f"is its start/length inside the file?") from None
        n_i = sum(1 for t, _ in frames if t == "I")
        log(f"  {len(frames)} frames, {n_i} I-frame(s)" + (" (cached)" if hit else ""))
        encoded.append(frames)
        paths.append(m4v)
    return ffmpeg, w, h, fps, encoded, paths


def heal_keys(n_clips, cuts, trim_b, heal_after):
    """Which clips need a forced keyframe (and where) to heal the mosh."""
    keys = {}
    for ci in range(1, n_clips):
        cut_on = cuts[ci - 1] if cuts and ci - 1 < len(cuts) else True
        hf = heal_frame(trim_b, heal_after)
        if cut_on and hf is not None:
            keys[ci] = [hf]
    return keys


def scan_clips(clips, quant=2, size=None, fps=None, cuts=None, trim_b=0, heal_after=0,
               thumbs_dir=None, log=print, cancel=None, gop=999):
    """Encode the clips (cached) and list their keyframes, for the keyframe picker.

    Returns {"keyframes": [{"clip", "frame", "time", "cut", "first", "heal", "thumb"}], ...}.
    """
    def work():
        force = heal_keys(len(clips), cuts, trim_b, heal_after)
        ffmpeg, w, h, f, encoded, paths = prepare(clips, quant, size, fps, log, force, gop)
        kfs = []
        for ci, frames in enumerate(encoded):
            heal = force.get(ci, [None])[0]
            thumbs = []
            if thumbs_dir:
                check_cancel()
                Path(thumbs_dir).mkdir(parents=True, exist_ok=True)
                pattern = Path(thumbs_dir) / f"c{ci}_%04d.png"
                run([ffmpeg, "-y", "-v", "error", "-skip_frame", "nokey", "-i", str(paths[ci]),
                     "-vf", "scale=120:-2", "-fps_mode", "passthrough", str(pattern)])
                thumbs = sorted(Path(thumbs_dir).glob(f"c{ci}_*.png"))
            n = 0
            for fi, (t, _) in enumerate(frames):
                if t != "I":
                    continue
                kfs.append({"clip": ci, "frame": fi, "time": fi / float(f),
                            "cut": fi == 0 and ci > 0, "first": ci == 0 and fi == 0,
                            "heal": fi == heal,
                            "thumb": thumbs[n].name if n < len(thumbs) else None})
                n += 1
        log(f"Found {len(kfs)} keyframe(s)")
        return {"keyframes": kfs, "fps": float(f), "width": w, "height": h,
                "frames": [len(x) for x in encoded]}
    return _guarded(work, [], cancel)


def mosh_clips(clips, output, trim_a=0, trim_b=0, only_joins=False, quant=2,
               size=None, fps=None, avi=None, log=print, cancel=None, preview=None,
               mode="auto", cuts=None, heal_after=0, keyframes=None, frame_range=None,
               timeline_starts=None, gop=999, bloom=0, bloom_at=0, bloom_auto=True,
               bloom_smooth=True, bloom_points=None, bloom_cuts=None,
               smear_frames=0, smear_repeat=1, color=None):
    """Run the whole pipeline.

    clips: list of dicts {"path": str, "start": seconds or None, "duration": seconds or None}
    size:  (w, h) or None for the first clip's size
    fps:   number / "30000/1001" / Fraction, or None for the first clip's rate
    cancel:  threading.Event; setting it stops the job (raises Cancelled)
    preview: path for a PNG strip of frames around the first moshed cut
    mode:    "auto" (rules below) or "manual" (delete exactly `keyframes`)
    cuts:    per-cut on/off list (False = normal hard cut)
    heal_after: put a clean keyframe back this many frames after each moshed cut (0 = off)
    frame_range: (start_s, end_s) timeline range; auto mode only removes keyframes inside it
    timeline_starts: each clip's start on the timeline in seconds (for frame_range)
    gop:      longest gap between keyframes when encoding (999 = scene changes only)
    bloom:    repeat one motion frame this many times after each moshed cut (0 = off)
    bloom_at: which frame: this many frames after the cut (when bloom_auto is off)
    bloom_auto:   pick the frame with the strongest motion after the cut instead
    bloom_smooth: repeat a low-quality copy of that frame (pure motion, few colour
                  corrections) and soften block edges: soft trails instead of colour blow-outs
    bloom_points: [[clip, frame], ...] bloom exactly these frames (e.g. under the playhead)
    bloom_cuts:   per cut True/False: which cuts get a bloom (default: every moshed cut)
    smear_frames / smear_repeat: smear boost: the first N motion frames after each moshed
                  cut are each repeated this many times (heavier drag; 0 / 1 = off)
    color:        acid colour, see color_filter() (None = off)
                  instead of one per cut
    Returns a summary dict.
    """
    def work():
        force = heal_keys(len(clips), cuts, trim_b, heal_after)
        ffmpeg, w, h, f, encoded, _ = prepare(clips, quant, size, fps, log, force, gop)
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        check_cancel()
        drops = plan_drops(encoded, f, mode=mode, only_joins=only_joins, cuts=cuts,
                           heal_after=heal_after, trim_b=trim_b, keyframes=keyframes,
                           frame_range=frame_range, timeline_starts=timeline_starts)
        blooms = {}
        targets = []                 # (clip, frame) to bloom
        if bloom > 0 and bloom_points:
            for ci, want in bloom_points:     # chosen frames (e.g. the playhead)
                ci, want = int(ci), max(0, int(want))
                if 0 <= ci < len(encoded):
                    fi = pick_bloom_frame(encoded[ci], ci, want, drops, auto=False)
                    if fi is not None:
                        targets.append((ci, fi))
        elif bloom > 0 and len(encoded) == 1:
            # A single clip has no cut. Strongest motion searches the whole clip;
            # "after cut" has nothing to count from, so it doesn't bloom at the start.
            if bloom_auto:
                fi = pick_bloom_frame(encoded[0], 0, 1, drops, auto=True, window=len(encoded[0]))
                if fi is not None:
                    targets.append((0, fi))
            else:
                log("  bloom: 'after cut' needs a cut (2+ clips); nothing bloomed")
        elif bloom > 0:
            # one bloom after each real cut that is moshed and has bloom switched on
            for ci in range(1, len(encoded)):
                if cuts and ci - 1 < len(cuts) and not cuts[ci - 1]:
                    continue                     # hard cut: no bloom
                if bloom_cuts and ci - 1 < len(bloom_cuts) and not bloom_cuts[ci - 1]:
                    continue                     # bloom switched off for this cut
                start = bloom_frame(trim_b, 0 if bloom_auto else bloom_at)
                fi = pick_bloom_frame(encoded[ci], ci, start, drops, auto=bloom_auto)
                if fi is not None:
                    targets.append((ci, fi))
        for ci, fi in targets:
            frame = encoded[ci][fi]
            if bloom_smooth:
                # Same clip encoded at low quality: its version of this frame carries
                # the motion with hardly any colour corrections.
                coarse, _ = encode_cached(ffmpeg, clips[ci], w, h, f, BLOOM_SMOOTH_QUANT,
                                          force.get(ci), gop)
                cf = split_frames(coarse.read_bytes())
                if len(cf) == len(encoded[ci]) and cf[fi][0] == "P":
                    frame = cf[fi]
                else:
                    log("  (smooth bloom: low-quality copy didn't line up; using the normal frame)")
            blooms[ci] = (fi, [frame] * int(bloom))
            log(f"  bloom: clip {ci + 1}, frame {fi} ({fi / float(f):.2f}s into the clip)")
        frames, removed, joins, mosh_joins = mosh(encoded, trim_a, trim_b, drops=drops, cuts=cuts,
                                                  blooms=blooms, smear_frames=int(smear_frames),
                                                  smear_repeat=int(smear_repeat))
        bloomed = getattr(mosh, "last_bloomed", 0)
        smeared = getattr(mosh, "last_smeared", 0)
        log(f"Deleted {removed} I-frame(s); {len(frames)} frames remain")
        if smeared:
            log(f"Smear boost: first {smear_frames} motion frames after each cut x{smear_repeat} "
                f"(+{smeared} frames)")
        if color:
            log("Acid colour: " + ", ".join(f"{k} {v}" for k, v in color.items()))
        if bloomed:
            log(f"Bloom{' (smooth)' if bloom_smooth else ''}: +{bloomed} frames at {len(blooms)} point(s)")
        if heal_after and mosh_joins:
            log(f"Heals {heal_after} frame(s) after each moshed cut")

        with tempfile.TemporaryDirectory(prefix="mosh_") as tmp:
            moshed = Path(tmp) / "moshed.m4v"
            moshed.write_bytes(b"".join(p for _, p in frames))
            if avi:
                remux_avi(ffmpeg, moshed, avi, f)
                log(f"Wrote {avi}")
            log("Converting to ProRes...")
            decode_to_prores(ffmpeg, moshed, output, f, soften=bool(blooms) and bloom_smooth,
                             color=color, joins=joins, size=(w, h))
            log(f"Wrote {output}")
        offsets = None
        focus = (mosh_joins or joins or [0])[0]
        if not joins and blooms:
            # single clip: centre the preview on where the bloom starts
            ci, (fi, _) = next(iter(blooms.items()))
            focus = fi + 1 - sum(1 for c, d in drops if c == ci and d < fi)
        if preview and (joins or removed or blooms):
            log("Making preview...")
            offsets = make_preview(ffmpeg, output, focus, len(frames), preview)
        return {"output": str(output), "frames": len(frames), "iframes_removed": removed,
                "fps": float(f), "width": w, "height": h, "joins": joins,
                "moshJoins": mosh_joins, "seconds": len(frames) / float(f), "bloomed": bloomed,
                "smeared": smeared,
                "preview": str(preview) if offsets else None, "previewOffsets": offsets,
                "avi": str(avi) if avi else None}
    return _guarded(work, [output, avi], cancel)


MOSH_FFMPEG_DIR = None


def parse_clip_arg(arg):
    """'file.mp4' or 'file.mp4@START-END' (seconds)."""
    if "@" in arg:
        path, rng = arg.rsplit("@", 1)
        if "-" in rng:
            a, b = rng.split("-", 1)
            start = float(a) if a else 0.0
            return {"path": path, "start": start, "duration": float(b) - start if b else None}
    return {"path": arg, "start": None, "duration": None}


def main():
    global MOSH_FFMPEG_DIR
    ap = argparse.ArgumentParser(description="Avidemux-style datamosh transition.")
    ap.add_argument("clips", nargs="+",
                    help="input clips in order; optionally file@START-END in seconds")
    ap.add_argument("-o", "--output", help="output .mov (ProRes 422 HQ)")
    ap.add_argument("--trim-a", type=int, default=0,
                    help="frames to delete from the end of each clip before a join")
    ap.add_argument("--trim-b", type=int, default=0,
                    help="frames to delete from the start of each clip after a join")
    ap.add_argument("--only-joins", action="store_true",
                    help="only delete I-frames at joins, keep ones inside clips")
    ap.add_argument("--heal-after", type=int, default=0,
                    help="put a clean keyframe back N frames after each moshed cut")
    ap.add_argument("--hard-cuts", default="",
                    help="comma-separated cut numbers (1 = first cut) to leave as normal cuts")
    ap.add_argument("--range", help="START-END seconds: only remove keyframes in this part")
    ap.add_argument("--keyframes", help="manual mode: CLIP:FRAME,... keyframes to delete "
                                        "(0-based; see --scan)")
    ap.add_argument("--scan", action="store_true", help="just list keyframes and exit")
    ap.add_argument("--gop", type=int, default=999,
                    help="longest gap between keyframes when encoding (default 999)")
    ap.add_argument("--bloom", type=int, default=0,
                    help="repeat a motion frame N times after each moshed cut")
    ap.add_argument("--bloom-at", type=int, default=0,
                    help="...this many frames after the cut (default 0)")
    ap.add_argument("--bloom-point", action="append", default=[],
                    help="CLIP:FRAME (0-based) to bloom exactly there; repeatable")
    ap.add_argument("--smear", type=int, default=0,
                    help="smear boost: first N motion frames after each cut get repeated")
    ap.add_argument("--smear-x", type=int, default=3, help="...this many times each (default 3)")
    ap.add_argument("--acid", action="store_true", help="acid colour on the result")
    ap.add_argument("--sat", type=float, default=3.0, help="acid: saturation (1 = normal)")
    ap.add_argument("--contrast", type=float, default=1.5, help="acid: contrast (1 = normal)")
    ap.add_argument("--brightness", type=float, default=0.0, help="acid: brightness (-0.5..0.5)")
    ap.add_argument("--hue-jump", type=float, default=120, help="acid: hue jump per cut, degrees")
    ap.add_argument("--neon", action="store_true", help="acid: purple/magenta/blue tint")
    ap.add_argument("--style", choices=("prism", "pure", "tint"), default="tint",
                    help="acid: prism (many pure colours), pure (clip to primaries) or tint")
    ap.add_argument("--objects", action="store_true",
                    help="acid: colour clocks (each original colour cycles on its own clock)")
    ap.add_argument("--families", type=int, default=6, help="acid colour clocks: colour families 3..12")
    ap.add_argument("--per-object", action="store_true",
                    help="acid colour clocks: one clock per detected object instead of per colour")
    ap.add_argument("--detail", type=int, default=5, help="acid objects: 1 (big) .. 10 (small)")
    ap.add_argument("--regions", type=int, default=0,
                    help="acid: split into N brightness regions that each spin their own way")
    ap.add_argument("--spin", type=float, default=0,
                    help="acid: colours rotate this many degrees every frame")
    ap.add_argument("--posterize", type=int, default=0, help="acid: colour levels (0 = off)")
    ap.add_argument("--bloom-cuts", help="comma-separated cut numbers (1 = first cut) to bloom; "
                                         "default: every moshed cut")
    ap.add_argument("--bloom-manual", action="store_true",
                    help="bloom exactly at --bloom-at instead of the strongest-motion frame")
    ap.add_argument("--bloom-raw", action="store_true",
                    help="repeat the full-quality frame and don't soften (harsher, colourful)")
    ap.add_argument("--quant", type=int, default=2, help="Xvid quantizer 1-31 (lower = better)")
    ap.add_argument("--size", help="WxH (default: first clip's size)")
    ap.add_argument("--fps", help="frame rate, e.g. 30 or 30000/1001 (default: first clip's)")
    ap.add_argument("--avi", help="also save the raw moshed Xvid AVI here")
    ap.add_argument("--ffmpeg-dir", help="folder containing ffmpeg and ffprobe")
    args = ap.parse_args()
    MOSH_FFMPEG_DIR = args.ffmpeg_dir

    size = tuple(int(v) for v in args.size.lower().split("x")) if args.size else None
    clips = [parse_clip_arg(c) for c in args.clips]
    hard = {int(x) for x in args.hard_cuts.split(",") if x.strip()}
    cuts = [(i + 1) not in hard for i in range(len(clips) - 1)]

    if args.scan:
        r = scan_clips(clips, quant=args.quant, size=size, fps=args.fps, cuts=cuts,
                       trim_b=args.trim_b, heal_after=args.heal_after, gop=args.gop)
        for k in r["keyframes"]:
            tag = "first" if k["first"] else "cut" if k["cut"] else "heal" if k["heal"] else ""
            print(f"  {k['clip']}:{k['frame']:<6} {k['time']:7.2f}s  {tag}")
        return
    if not args.output:
        ap.error("-o/--output is required (unless --scan)")

    rng = None
    if args.range:
        a, b = args.range.split("-", 1)
        rng = (float(a), float(b))
    manual = None
    if args.keyframes:
        manual = [[int(x) for x in kf.split(":")] for kf in args.keyframes.split(",")]
    mosh_clips(clips, args.output,
               trim_a=args.trim_a, trim_b=args.trim_b, only_joins=args.only_joins,
               quant=args.quant, size=size, fps=args.fps, avi=args.avi,
               mode="manual" if manual else "auto", keyframes=manual, cuts=cuts,
               heal_after=args.heal_after, frame_range=rng, gop=args.gop,
               bloom=args.bloom, bloom_at=args.bloom_at, bloom_auto=not args.bloom_manual,
               bloom_smooth=not args.bloom_raw,
               bloom_points=[[int(x) for x in p.split(":")] for p in args.bloom_point] or None,
               bloom_cuts=([(i + 1) in {int(x) for x in args.bloom_cuts.split(",") if x.strip()}
                            for i in range(len(clips) - 1)] if args.bloom_cuts else None),
               smear_frames=args.smear, smear_repeat=args.smear_x,
               color=({"sat": args.sat, "contrast": args.contrast, "brightness": args.brightness,
                       "hue_jump": args.hue_jump, "style": args.style, "spin": args.spin, "regions": args.regions, "objects": args.objects, "detail": args.detail, "families": args.families,
                       "clock": "objects" if args.per_object else "colors",
                       "neon": args.neon, "posterize": args.posterize} if args.acid else None))


if __name__ == "__main__":
    main()
