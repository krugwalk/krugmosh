# Datamosh for Premiere Pro

Avidemux-style datamosh transitions, inside Premiere Pro.

Select two (or more) clips with a cut between them, click **MOSH IT**, and a moshed
ProRes clip lands on the track above. It works exactly like the manual Avidemux
method: encode to Xvid (0 B-frames, GOP 999), delete every I-frame except the
first, optionally delete frames around the cut.

```
datamosh/
  panel/            the Premiere panel (UXP): manifest.json, index.html, styles.css, main.js
  mosh.py           the moshing engine (also usable from the command line)
  mosh_server.py    local helper the panel talks to (Premiere panels can't run programs)
  datamosh_helper.pyw     the helper, windowless (double-click; logs to helper.log)
  install_autostart.bat   run once: helper starts hidden with Windows, forever
  uninstall_autostart.bat undo that
  stop_helper.bat         stop any running helper
  start_helper.bat        the helper in a visible window (handy for debugging)
  scripts/          helper_tools.ps1 used by the .bat files
  test-output/      sample clips and results
```

## The helper (no window needed)

Premiere panels aren't allowed to run programs like ffmpeg, so a small helper does
the encoding. It doesn't need a window:

- **Easiest:** run `install_autostart.bat` once. The helper then starts hidden every
  time Windows starts, and you never think about it again. (`uninstall_autostart.bat`
  removes it.)
- **Or:** click **Start helper** in the panel's red banner (if Premiere allows it), or
  double-click `datamosh_helper.pyw`. Either starts it hidden until you log off.
- Only one helper ever runs; starting another just exits. Messages go to `helper.log`.
- After updating the code, run `stop_helper.bat`, then start it again.

## One-time setup

1. **Install UXP Developer Tools.** Open the Creative Cloud app, search for
   "UXP Developer Tools" and install it.
2. **Allow developer plugins in Premiere.** In Premiere Pro, open
   Settings → Plugins and turn on **Enable developer mode**, then restart Premiere.
   (If UXP Developer Tools doesn't list Premiere Pro as connected, this is usually why.)

## Each time you use it

1. **Helper:** nothing to do if you ran `install_autostart.bat`; otherwise click
   **Start helper** in the panel (see above).
2. **Load the panel.** Open UXP Developer Tools → **Add Plugin** → choose
   `datamosh/panel/manifest.json` (first time only) → click **••• → Load**.
   The panel opens in Premiere (also under Window → UXP Plugins → Datamosh).
3. **Mosh.**
   - Put two clips next to each other on a video track and select both.
   - Click **Use selection**. The dot top-right should say *helper online*.
   - Adjust trims if you like, then **MOSH IT**.
   - The result is saved to `Datamosh Renders` next to your project file, imported,
     and placed on the track above your clips.

Tip: moshing looks best when the **incoming** clip has lots of movement
(camera moves, people moving). Flat or static shots barely smear.

## Settings

Hover any setting in the panel to see what it does. Settings are remembered between sessions; **Reset** restores defaults.

### Clip source

| Option | What gets moshed |
|---|---|
| **As on timeline** (default) | Premiere first renders the selected clips exactly as they look in the sequence (crop, scale, position, speed, colour, effects) via a temporary subsequence and a ProRes 422 HQ "match source" preset, then that render is moshed. The render is reused between Scan and Mosh; click **Use selection** again after changing effects. Renders live in your temp folder and are deleted after a day. |
| **Original media** | The untouched source files (just the trimmed in/out). Faster, but ignores effects and speed. |

### Choosing which keyframes go

| Option | How |
|---|---|
| **Auto** (default) | One click: removes every keyframe after the first (or only those at cuts). |
| **Only between sequence In/Out** | Auto mode checkbox. Set In/Out on the timeline (I / O), click **Use selection**, and only keyframes inside that range are removed. |
| **Pick keyframes** | Switch mode, click **Scan keyframes**: every keyframe is listed with a thumbnail, its time and a tag (START / CUT / scene change). Tick exactly the ones to delete; **All / Cuts / None** are shortcuts. The mosh reuses the scan's encode, so it isn't encoded twice. If you change clips, Block size or (with healing on) cuts/trims, the panel asks you to scan again. |
| **Per-cut on/off** | Click the **▼ mosh here ▼** marker between two clips to turn it into a **── hard cut ──** (and back). In Pick mode the cut's keyframe tick follows it. |
| **Heal after** | Slider: puts a clean keyframe back N frames after each moshed cut, so the picture snaps back at a point you choose instead of fading out on its own. |
| **Bloom** | Tick it: one motion frame is copied and pasted *Repeat* times (up to 3000), like in Avidemux, so the picture keeps following that movement and blooms out. Which frame: **Strongest motion** (default, picked after each cut), **After cut** (*Bloom at* frames after each cut) or **Playhead** (park the playhead on a frame, click **Use playhead**). In the first two, click the **✿ bloom** chip on a cut in the clip list to choose which cuts get a bloom. With a single clip there's no cut: use Strongest motion (searches the whole clip) or Playhead. **Smooth** (default on) repeats a low-quality copy of the frame and softens block edges for soft trails and natural colours; off = harsher, colourful blow-outs. Adds *Repeat* frames to the moshed clip. |
| **Smear boost** / **Smear strength** | Glitch section. Right after each moshed cut, the first N motion frames are each played *strength* times, so the whole movement is replayed and the old picture is dragged much harder. |
| **Acid colour** | Glitch section. Style: **Prism** (brightness mapped onto a rainbow: many pure colours per frame), **Pure colours** (clipped to primaries) or **Tint**. **Hue spin** turns all colours around the wheel every frame like a fast clock (30°/frame ≈ 3 turns a second). **Colour clocks** gives every original colour its own clock: everything that was the same colour (a red shirt, white text, a blue sky) cycles together, different colours cycle at their own speed and direction; **Colours** sets how many colour families (3–12, plus darks / mids / lights). Needs `python -m pip install numpy opencv-python-headless`. |
| **⚡ Acid preset** | One click towards the fast-cut neon glitch look: every cut moshed, raw bloom 8 on the strongest motion, smear boost 10 ×3, Pure colours 600% / 180% / brightness +5 / posterize 3, every colour on its own clock (30°/frame). Works best with many short, very different shots that have lots of movement. |
| **GOP size** | Longest gap between keyframes when encoding. 999 (default, like the tutorial) = keyframes only at scene changes. Lower values (e.g. 30) add regular keyframes, giving Pick mode more points to choose from. |

| Control | What it does | Avidemux equivalent |
|---|---|---|
| Drop frames before cut | Deletes N frames from the end of the outgoing clip | Selecting/deleting frames before the join |
| Drop frames after cut | Deletes N frames from the start of the incoming clip | Selecting/deleting frames after the join |
| Block size | Xvid quantizer (1 = fine, 12 = huge blocks) | Encoder quality setting |
| Keep clips clean, only mosh at the cut | Keeps scene-change keyframes *inside* clips | Leaving those I-frames alone |
| Keep raw .avi copy | Also saves the raw moshed Xvid file | The file you'd save from Avidemux |

While moshing, the button turns into **CANCEL** (half-written files are cleaned up).
When done, the **Result** card shows frames around the cut (−3 … +24 frames) and
**Show in Explorer** opens the rendered file's folder. **Details** shows the full log.

## Command line (no Premiere)

```
python mosh.py clipA.mp4 clipB.mp4 -o moshed.mov --trim-b 3
python mosh.py "clipA.mp4@2-5.5" "clipB.mp4@0-4" -o moshed.mov   # use only part of each clip (seconds)
python mosh.py a.mp4 b.mp4 c.mp4 --scan                            # list keyframes as CLIP:FRAME
python mosh.py a.mp4 b.mp4 c.mp4 -o out.mov --keyframes 1:0,2:45   # delete exactly these
python mosh.py a.mp4 b.mp4 c.mp4 -o out.mov --hard-cuts 2          # leave cut 2 as a normal cut
python mosh.py a.mp4 b.mp4 -o out.mov --heal-after 20              # snap back 20 frames after the cut
python mosh.py a.mp4 b.mp4 c.mp4 -o out.mov --range 2-5.5          # only remove keyframes in 2-5.5 s
python mosh.py a.mp4 b.mp4 -o out.mov --bloom 500                  # bloom the strongest-motion frame 500x
python mosh.py a.mp4 b.mp4 -o out.mov --bloom 500 --bloom-point 1:45   # bloom clip 2, frame 45
python mosh.py a.mp4 b.mp4 -o out.mov --bloom 500 --bloom-raw      # harsher, un-smoothed bloom
python mosh.py a.mp4 b.mp4 c.mp4 -o out.mov --smear 10 --smear-x 3 --acid --neon   # glitch look
python mosh.py a.mp4 b.mp4 --scan --gop 30                         # keyframe at least every 30 frames
```

Encoded clips are cached in your temp folder (`datamosh_cache`, cleared after a day),
so re-moshing the same clips with different settings is fast.

## Developing

Open `panel/index.html` in a browser (served over http) to preview the UI without
Premiere; it uses the clips in `test-output/`. To test a helper without stopping
the one you're using: `set DATAMOSH_PORT=8766` then `python mosh_server.py`, and
open the panel with `?port=8766`.

## Known limits (v0.4)

- No audio in the moshed clip; your original audio stays on the timeline.
- In **Original media** mode, effects and speed changes are ignored (use **As on timeline**).
- In **Original media** mode, nested sequences / graphics can't be moshed (no media file).
