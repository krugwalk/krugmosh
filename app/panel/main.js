/* Krugmosh panel for Premiere Pro (UXP).
 *
 * Flow: read the selected clips on the timeline -> send their file paths and
 * in/out ranges to the local helper (mosh_server.py) -> poll for progress ->
 * import the moshed ProRes file and place it on the track above the clips.
 *
 * Opened outside Premiere (e.g. in a browser), it runs in PREVIEW mode with the
 * test clips from ../test-output so the UI and helper can be tested without
 * Premiere.
 */

let ppro = null;
try { ppro = require("premierepro"); } catch (e) { ppro = null; }
const PREVIEW = !ppro;

// Browser preview can point at a test helper with ?port=NNNN.
const PORT = (PREVIEW && /[?&]port=(\d+)/.test(location.search)) ? RegExp.$1 : "8765";
const HELPER_URLS = ["http://127.0.0.1:" + PORT, "http://localhost:" + PORT];
let HELPER = HELPER_URLS[0];
let lastHelperError = null;

const $ = (id) => document.getElementById(id);
const state = {
  clips: [], seqInfo: null, busy: false, helperOk: false,
  job: null, cancelRequested: false, startedAt: 0, timer: null, lastResultJob: null,
  mode: "auto",          // "auto" | "manual"
  cuts: [],              // per cut: true = mosh, false = hard cut
  scan: null,            // { key, job, keyframes: [...] } from the last scan
  picked: new Set(),     // "clip:frame" keyframes ticked in the picker
  removed: new Set(),    // clips taken out with × (kept out until Use selection is clicked)
  selClips: [],          // everything selected on the timeline at the last read
  bloomCuts: [],         // per cut: false = no bloom there (Strongest motion / After cut)
};

const DEFAULTS = {
  trimA: 0, trimB: 0, quant: 2, healAfter: 0, gop: 999, bloomOn: false, bloom: 150, bloomAt: 0, bloomWhich: "auto", bloomSmooth: true,
  smearFrames: 0, smearRepeat: 3, acidOn: false, acidStyle: "prism", spin: 30, objectsOn: true, detail: 6, sat: 300, contrast: 150, brightness: 0, hueJump: 0,
  posterize: 0, neon: false, onlyJoins: false, useRange: false,
  keepAvi: false, audioOn: true, targetOn: false, pickSens: 4, trail: 30, blockSize: 16, bleed: 3,
  mode: "auto", showMarkers: false, source: "timeline",
};
const SETTINGS_KEY = "krugmosh.settings.v1";

// ------------------------------------------------------------------ settings

/** Slider value as a whole number within its min/max (Premiere's slider can report fractions). */
function sliderInt(id) {
  const el = $(id);
  const v = Math.round(Number(el.value));
  return Math.max(Number(el.min), Math.min(Number(el.max), isNaN(v) ? Number(el.min) : v));
}

/** −/+ buttons: move a slider by exactly one step. */
function stepSlider(id, delta) {
  const el = $(id);
  el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), sliderInt(id) + delta)));
  updateValueLabels();
  saveSettings();
}

function readSettings() {
  return {
    trimA: sliderInt("trimA"),
    trimB: sliderInt("trimB"),
    quant: sliderInt("quant"),
    healAfter: sliderInt("healAfter"),
    gop: sliderInt("gop"),
    bloomOn: $("bloomOn").checked,
    bloomWhich: state.bloomWhich || "auto",
    bloomSmooth: $("bloomSmooth").checked,
    smearFrames: sliderInt("smearFrames"),
    smearRepeat: sliderInt("smearRepeat"),
    acidOn: $("acidOn").checked,
    acidStyle: state.acidStyle || "prism",
    spin: sliderInt("spin"),
    objectsOn: $("objectsOn").checked,
    detail: sliderInt("detail"),
    sat: sliderInt("sat"),
    contrast: sliderInt("contrast"),
    brightness: sliderInt("brightness"),
    hueJump: sliderInt("hueJump"),
    posterize: sliderInt("posterize"),
    neon: $("neon").checked,
    bloom: sliderInt("bloom"),
    bloomAt: sliderInt("bloomAt"),
    onlyJoins: $("onlyJoins").checked,
    useRange: $("useRange").checked,
    keepAvi: $("keepAvi").checked,
    audioOn: $("audioOn").checked,
    targetOn: $("targetOn").checked,
    pickSens: sliderInt("pickSens"),
    trail: sliderInt("trail"),
    blockSize: sliderInt("blockSize"),
    bleed: sliderInt("bleed"),
    mode: state.mode,
    showMarkers: $("showMarkers").checked,
    source: state.source,
  };
}

function applySettings(s) {
  $("trimA").value = s.trimA;
  $("trimB").value = s.trimB;
  $("quant").value = s.quant;
  $("healAfter").value = s.healAfter;
  $("gop").value = s.gop;
  $("bloomOn").checked = !!s.bloomOn;
  $("bloomSmooth").checked = s.bloomSmooth !== false;
  $("smearFrames").value = s.smearFrames;
  $("smearRepeat").value = s.smearRepeat;
  $("acidOn").checked = !!s.acidOn;
  $("spin").value = s.spin === undefined ? 30 : s.spin;
  $("objectsOn").checked = s.objectsOn !== false;
  $("detail").value = s.detail === undefined ? 6 : s.detail;
  showDetail();
  setAcidStyle(s.acidStyle || "prism", true);
  $("sat").value = s.sat;
  $("contrast").value = s.contrast;
  $("brightness").value = s.brightness || 0;
  $("hueJump").value = s.hueJump;
  $("posterize").value = s.posterize;
  $("neon").checked = !!s.neon;
  showAcidOpts();
  setBloomWhich(s.bloomWhich || "auto", true);
  $("bloom").value = s.bloom;
  showBloomOpts();
  $("bloomAt").value = s.bloomAt;
  $("onlyJoins").checked = !!s.onlyJoins;
  $("useRange").checked = !!s.useRange;
  $("keepAvi").checked = !!s.keepAvi;
  $("audioOn").checked = s.audioOn !== false;
  $("targetOn").checked = !!s.targetOn;
  $("pickSens").value = s.pickSens === undefined ? 4 : s.pickSens;
  $("trail").value = s.trail === undefined ? 30 : s.trail;
  $("blockSize").value = s.blockSize === undefined ? 16 : s.blockSize;
  $("bleed").value = s.bleed === undefined ? 3 : s.bleed;
  showTargetOpts();
  $("showMarkers").checked = !!s.showMarkers;
  setSource(s.source, true);
  setMode(s.mode === "manual" ? "manual" : "auto", true);
  updateValueLabels();
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings())); } catch (e) { /* ignore */ }
}

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch (e) { saved = {}; }
  applySettings(Object.assign({}, DEFAULTS, saved));
}

/** Which frame gets bloomed: "auto" (strongest motion), "after" (Bloom at), "playhead". */
function setBloomWhich(which, silent) {
  state.bloomWhich = ["auto", "after", "playhead"].indexOf(which) === -1 ? "auto" : which;
  $("bwAuto").className = "seg-btn" + (state.bloomWhich === "auto" ? " on" : "");
  $("bwAfter").className = "seg-btn" + (state.bloomWhich === "after" ? " on" : "");
  $("bwPlayhead").className = "seg-btn" + (state.bloomWhich === "playhead" ? " on" : "");
  $("bloomAtCtl").className = "control" + (state.bloomWhich === "after" ? "" : " hidden");
  $("bloomPlayheadRow").className = "timeline-row" + (state.bloomWhich === "playhead" ? "" : " hidden");
  if (!silent) saveSettings();
  renderBloomPoint();
  if (typeof renderClips === "function" && $("clipList")) renderClips(state.lastWarnings);
  updateMoshButton();
}

function renderBloomNote(needCut) {
  const el = $("bloomNote");
  if (!el) return;
  let text = "";
  if ($("bloomOn").checked && state.bloomWhich !== "playhead") {
    if (needCut) text = "Only 1 clip is selected, so there's no cut. Select both clips around the cut (Shift-click), or use Playhead / Strongest motion.";
    else if (state.clips.length > 1) {
      const n = bloomCutCount();
      text = n ? `Blooms after ${n} cut(s). Click ✿ on a cut above to switch it.`
               : "No cut has ✿ bloom switched on (click ✿ on a cut above).";
    } else if (state.clips.length === 1) text = "One clip: blooms its strongest-motion frame.";
  }
  el.textContent = text;
  el.className = "sub-info" + (needCut || (text && text.indexOf("No cut") === 0) ? " warn-text" : "") +
                 (text ? "" : " hidden");
}

function renderBloomPoint() {
  const bp = state.bloomPoint;
  $("bloomPointText").textContent = bp && state.clips[bp.clip]
    ? `Clip ${bp.clip + 1}, ${bp.seconds.toFixed(2)}s in (frame ${bp.frame})`
    : "no frame chosen yet";
}

/** "Use playhead": which selected clip is under the playhead, and which frame of it. */
async function onUsePlayhead() {
  // Always use what is selected on the timeline right now.
  if (!(await onUseSelection({ auto: true }))) {
    logLine("Select the clip on the timeline first (nothing usable is selected).", true);
    return;
  }
  try {
    let t;
    if (PREVIEW) {
      t = state.clips[1] ? state.clips[1].timelineStart + 1.5 : 1.5;   // pretend playhead
      logLine(`(preview mode: pretending the playhead is at ${t.toFixed(2)}s)`);
    } else {
      const { sequence } = await getProjectAndSequence();
      t = (await sequence.getPlayerPosition()).seconds;
    }
    const ci = state.clips.findIndex((c) => t >= c.timelineStart - 1e-6 && t < c.timelineStart + c.duration);
    if (ci === -1) {
      logLine(`The playhead (${t.toFixed(2)}s) isn't inside any of the selected clips.`, true);
      return;
    }
    const fps = (state.seqInfo && state.seqInfo.fps) || 30;
    const seconds = t - state.clips[ci].timelineStart;
    state.bloomPoint = { clip: ci, frame: Math.round(seconds * fps), seconds };
    renderBloomPoint();
    updateMoshButton();
  } catch (e) {
    logLine("Couldn't read the playhead: " + (e.message || e), true);
  }
}

function setAcidStyle(style, silent) {
  state.acidStyle = ["prism", "pure", "tint"].indexOf(style) === -1 ? "prism" : style;
  $("stPrism").className = "seg-btn" + (state.acidStyle === "prism" ? " on" : "");
  $("stPure").className = "seg-btn" + (state.acidStyle === "pure" ? " on" : "");
  $("stTint").className = "seg-btn" + (state.acidStyle === "tint" ? " on" : "");
  if (!silent) saveSettings();
}

function showDetail() {
  $("detailCtl").className = "control" + ($("objectsOn").checked ? "" : " hidden");
}

function showAcidOpts() {
  $("acidOpts").className = "bloom-opts" + ($("acidOn").checked ? "" : " hidden");
}

/** ⚡ Acid preset: a starting point for the fast-cut neon glitch look. */
function applyAcidPreset() {
  const s = Object.assign(readSettings(), {
    mode: "auto", onlyJoins: false,
    bloomOn: true, bloom: 8, bloomWhich: "auto", bloomSmooth: false,
    smearFrames: 10, smearRepeat: 3,
    acidOn: true, acidStyle: "pure", spin: 30, objectsOn: true, detail: 6, sat: 600, contrast: 180, brightness: 5, hueJump: 0,
    posterize: 3, neon: false,
  });
  applySettings(s);
  showBloomOpts();
  saveSettings();
  renderClips(state.lastWarnings);
  logLine("⚡ Acid preset: every cut moshed, raw bloom 8, smear boost 10 ×3, pure colours, every colour on its own clock.");
}

/** Repeat / Bloom at only matter (and only show) while Bloom is ticked. */
function showBloomOpts() {
  $("bloomOpts").className = "bloom-opts" + ($("bloomOn").checked ? "" : " hidden");
}

/** Unit text shown after a number box. */
function frameUnit(n) {
  n = Number(n);
  return n === 0 ? "off" : n === 1 ? "frame" : "frames";
}

function quantUnit(q) {
  q = Number(q);
  return q <= 2 ? "fine" : q <= 5 ? "medium" : q <= 8 ? "chunky" : "huge";
}

const SLIDERS = ["trimA", "trimB", "quant", "healAfter", "gop", "bloom", "bloomAt",
                 "smearFrames", "smearRepeat", "sat", "contrast", "brightness", "hueJump", "posterize", "spin", "detail", "pickSens", "trail", "blockSize", "bleed"];

function unitFor(id, v) {
  if (id === "quant") return quantUnit(v);
  if (id === "gop") return v >= 999 ? "scenes only" : "frames";
  if (id === "bloomAt") return v === 1 ? "frame after" : "frames after";
  if (id === "bloom") return v === 1 ? "time" : "times";
  if (id === "smearRepeat") return "× each";
  if (id === "sat" || id === "contrast") return "%";
  if (id === "brightness") return v > 0 ? "brighter" : v < 0 ? "darker" : "normal";
  if (id === "hueJump") return v ? "° per cut" : "off";
  if (id === "spin") return v ? "° / frame" : "off";
  if (id === "detail") return "colours";
  if (id === "pickSens") return v <= 3 ? "precise" : v >= 8 ? "grabs a lot" : "medium";
  if (id === "trail") return v ? "frames" : "off";
  if (id === "blockSize") return "px";
  if (id === "bleed") return "%";
  if (id === "posterize") return v < 2 ? "off" : "levels";
  return frameUnit(v);
}

function updateValueLabels() {
  for (const id of SLIDERS) {
    const v = sliderInt(id);
    const box = $(id + "Num");
    // don't overwrite what the user is in the middle of typing
    if (document.activeElement !== box) box.value = String(v);
    $(id + "Val").textContent = unitFor(id, v);
  }
  refreshScanState();
  if (state.target && state.target.pick && sliderInt("pickSens") !== state.target.sens) schedulePickSens();
}

/** Typed value -> slider (whole number, clamped to the slider's range). */
function commitNumber(id) {
  const box = $(id + "Num");
  const slider = $(id);
  let v = Math.round(Number(String(box.value).trim()));
  if (box.value === "" || isNaN(v)) v = sliderInt(id);  // empty or junk: keep the old value
  v = Math.max(Number(slider.min), Math.min(Number(slider.max), v));
  slider.value = String(v);
  box.value = String(v);
  updateValueLabels();
  saveSettings();
}

function bindNumberBoxes() {
  for (const id of SLIDERS) {
    const box = $(id + "Num");
    box.addEventListener("change", () => commitNumber(id));
    box.addEventListener("blur", () => commitNumber(id));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { commitNumber(id); box.blur(); }
      if (e.key === "Escape") { box.value = String(sliderInt(id)); box.blur(); }
    });
    box.addEventListener("focus", () => { try { box.select(); } catch (e) { /* ignore */ } });
  }
}

// ------------------------------------------------------------------ targeted mosh

let pickSensTimer = null;

function showTargetOpts() {
  $("targetOpts").className = "bloom-opts" + ($("targetOn").checked ? "" : " hidden");
}

function renderPick() {
  const t = state.target;
  if (!t || !t.pick) {
    $("pickWrap").className = "pick-wrap hidden";
    $("confirmText").textContent = "";
    return;
  }
  $("pickWrap").className = "pick-wrap";
  $("pickImg").src = HELPER + "/pick/" + t.pick + "/image.png?t=" + Date.now();
  const tiny = t.clicks && t.coverage < 0.3;
  const huge = t.coverage > 50;
  $("pickNote").textContent = !t.clicks
    ? `Clip ${t.clipIndex + 1}, ${t.offset.toFixed(2)}s in: click the object in the picture.`
    : tiny ? `Almost nothing selected (${t.coverage}%): raise Sensitivity or click a bigger part of the object.`
    : huge ? `${t.coverage}% of the frame selected: it probably spilled into the background. Lower Sensitivity or Undo.`
    : `Selected ${t.coverage}% of the frame. Click more parts to add them; Undo / Clear to fix.`;
  $("pickNote").className = "sub-info" + (tiny || huge ? " warn-text" : "");
  $("confirmText").textContent = t.confirmed ? `✓ Confirmed (clip ${t.clipIndex + 1})` : "";
  $("confirmText").className = "sub-info" + (t.confirmed ? "" : "");
}

async function pickCall(body) {
  const r = await fetch(HELPER + "/pick/" + state.target.pick, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "pick failed");
  Object.assign(state.target, { clicks: j.clicks, coverage: j.coverage, sens: j.sensitivity, confirmed: false });
  renderPick();
  updateMoshButton();
}

function schedulePickSens() {
  clearTimeout(pickSensTimer);
  pickSensTimer = setTimeout(() => {
    pickCall({ sensitivity: sliderInt("pickSens") }).catch((e) => logLine(String(e.message || e), true));
  }, 300);
}

/** Pick object: the frame under the playhead (in a selected clip) to click the object in. */
async function onPickObject() {
  if (state.busy) return;
  try {
    if (!(await onUseSelection({ auto: true }))) {
      logLine("Select the clip on the timeline first.", true);
      return;
    }
    let idx = 0;
    let offset = 0;
    if (PREVIEW) {
      idx = state.clips.length > 1 ? 1 : 0;
      offset = 1.0;
    } else {
      const { sequence } = await getProjectAndSequence();
      const t = (await sequence.getPlayerPosition()).seconds;
      const i = state.clips.findIndex((c) => t >= c.timelineStart - 1e-6 && t < c.timelineStart + c.duration);
      if (i !== -1) { idx = i; offset = t - state.clips[i].timelineStart; }
      else logLine("Playhead isn't on a selected clip: using the start of the first one.");
    }
    setStatus("Loading the frame…", "busy");
    const src = await jobClips();                          // render first if "As on timeline"
    const r = await fetch(HELPER + "/pick", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clip: src.clips[idx], offset, sensitivity: sliderInt("pickSens"),
        size: state.seqInfo && state.seqInfo.size, fps: state.seqInfo && state.seqInfo.fps,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "couldn't load the frame");
    state.target = { pick: j.pick, clipIndex: idx, offset, clicks: 0, coverage: 0, sens: j.sensitivity,
                     confirmed: false, rendered: src.rendered, clipKey: clipKey(state.clips[idx]) };
    renderPick();
    setStatus("Click the object", "ok");
    updateMoshButton();
  } catch (e) {
    setStatus("Couldn't load the frame", "err");
    logLine(String(e.message || e), true);
  }
}

function onPickClick(e) {
  if (!state.target || !state.target.pick || state.busy) return;
  const r = $("pickImg").getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  pickCall({ click: [x, y] }).catch((err) => logLine(String(err.message || err), true));
}

function onConfirm() {
  const t = state.target;
  if (!t || !t.clicks) { logLine("Click the object in the picture first.", true); return; }
  if (t.coverage < 0.3) { logLine("Almost nothing is selected: raise Sensitivity or click a bigger part.", true); return; }
  t.confirmed = true;
  renderPick();
  updateMoshButton();
}

// ------------------------------------------------------------------ modes, cuts, picker

function setMode(mode, silent) {
  state.mode = mode;
  $("modeAuto").className = "seg-btn" + (mode === "auto" ? " on" : "");
  $("modeManual").className = "seg-btn" + (mode === "manual" ? " on" : "");
  $("autoOpts").className = "mode-opts" + (mode === "auto" ? "" : " hidden");
  $("manualOpts").className = "mode-opts" + (mode === "manual" ? "" : " hidden");
  if (!silent) saveSettings();
  refreshScanState();
  updateMoshButton();
}

function kfKey(k) { return k.clip + ":" + k.frame; }

/** Everything that changes which keyframes exist. If it differs from the scan's, rescan. */
function scanKey() {
  const s = readSettings();
  const heal = s.healAfter;
  return JSON.stringify({
    clips: state.clips.map((c) => [c.path, c.start, c.duration]),
    // a new Premiere render (after Use selection) can differ, so it needs a new scan
    source: state.source,
    render: state.source === "timeline" && !PREVIEW ? (state.render && state.render.path) : null,
    quant: s.quant,
    gop: s.gop,
    fps: state.seqInfo && state.seqInfo.fps,
    size: state.seqInfo && state.seqInfo.size,
    // heal keyframes depend on these only when healing is on
    heal: heal, trimB: heal ? s.trimB : 0, cuts: heal ? state.cuts : [],
  });
}

function scanIsFresh() { return !!state.scan && state.scan.key === scanKey(); }

/** Keyframes that the user can't untick/tick (first frame, heal points). */
function isLocked(k) { return k.first || k.heal; }

function refreshScanState() {
  if (!$("scanNote")) return;
  const note = $("scanNote");
  if (!state.clips.length) {
    note.textContent = "Use selection first, then scan.";
    note.className = "sub-info";
  } else if (!state.scan) {
    note.textContent = "Scan to list the keyframes in your clips.";
    note.className = "sub-info";
  } else if (!scanIsFresh()) {
    note.textContent = "Clips or settings changed since the scan. Scan again.";
    note.className = "sub-info warn-text";
  } else {
    const n = state.scan.keyframes.filter((k) => !isLocked(k)).length;
    note.textContent = `${state.picked.size} of ${n} keyframe(s) will be removed.`;
    note.className = "sub-info";
  }
  updateMoshButton();
}

function renderPicker() {
  const list = $("kfList");
  list.innerHTML = "";
  list.className = "kf-list" + (state.scan ? "" : " empty-list");
  if (!state.scan) { refreshScanState(); return; }
  let lastClip = -1;
  for (const k of state.scan.keyframes) {
    if (k.clip !== lastClip) {
      lastClip = k.clip;
      const h = document.createElement("div");
      h.className = "kf-clip";
      const c = state.clips[k.clip];
      h.textContent = "Clip " + (k.clip + 1) + (c ? " · " + c.name : "");
      list.appendChild(h);
    }
    const locked = isLocked(k);
    const picked = state.picked.has(kfKey(k));
    const row = document.createElement("div");
    row.className = "kf" + (picked ? " picked" : "") + (locked ? " locked" : "") +
                    (state.currentKf === kfKey(k) ? " current" : "");
    row.title = "Click to jump the playhead here";
    row.addEventListener("click", () => jumpTo(k));

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = picked;
    box.disabled = locked || state.busy;
    box.addEventListener("click", (e) => e.stopPropagation());  // ticking shouldn't jump
    box.addEventListener("change", () => onPick(k, box.checked));
    row.appendChild(box);
    if (window.w7Check) window.w7Check(box);   // Win7-style tick box

    const img = document.createElement("img");
    img.className = "kf-thumb";
    if (k.thumb) img.src = HELPER + "/jobs/" + state.scan.job + "/thumb/" + k.thumb;
    row.appendChild(img);

    const text = document.createElement("div");
    text.className = "kf-text";
    const main = document.createElement("span");
    main.className = "kf-main";
    main.textContent = "Frame " + k.frame + " · " + k.time.toFixed(2) + "s";
    const tag = k.first ? ["START", ""] : k.cut ? ["CUT", "cut"] : k.heal ? ["HEAL", "heal"] : null;
    if (tag) {
      const t = document.createElement("span");
      t.className = "tag " + tag[1];
      t.textContent = tag[0];
      main.appendChild(t);
    }
    const sub = document.createElement("span");
    sub.className = "kf-sub";
    const c = state.clips[k.clip];
    const tl = c ? c.timelineStart + k.time : null;
    sub.textContent = k.first ? "always kept (start of the mosh)"
      : k.heal ? "kept: heal point"
      : k.cut ? "cut between clip " + k.clip + " and " + (k.clip + 1)
      : "scene change" + (tl != null ? " · timeline " + tl.toFixed(2) + "s" : "");
    text.appendChild(main);
    text.appendChild(sub);
    row.appendChild(text);
    list.appendChild(row);
  }
  refreshScanState();
  scheduleMarkers();
}

// ------------------------------------------------------------------ timeline markers

const MARKER_PREFIX = "Mosh: ";
const MARKER_RED = 1;    // Premiere marker colours: 0 green, 1 red, 2 purple, 3 orange, ...
const MARKER_GREEN = 0;
let markerTimer = null;
let lastMarkerSig = null;

function keyframeTimelineTime(k) {
  const c = state.clips[k.clip];
  return c ? c.timelineStart + k.time : null;
}

/** Move the playhead to a keyframe so it shows in the Program monitor. */
async function jumpTo(k) {
  state.currentKf = kfKey(k);
  renderPicker();
  const t = keyframeTimelineTime(k);
  if (t == null) return;
  if (PREVIEW) { logLine(`(preview mode: playhead would jump to ${t.toFixed(2)}s)`); return; }
  try {
    const { sequence } = await getProjectAndSequence();
    await sequence.setPlayerPosition(ppro.TickTime.createWithSeconds(t));
  } catch (e) {
    logLine("Couldn't move the playhead: " + (e.message || e), true);
  }
}

/** Refresh markers shortly after the picks change (batched so ticking fast is cheap). */
function scheduleMarkers() {
  if (!$("showMarkers").checked || !state.scan || state.busy) return;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => {
    syncMarkers().catch((e) => logLine("Timeline markers failed: " + (e.message || e), true));
  }, 500);
}

/** "Mark timeline" button: place markers now, even if nothing changed. */
async function onMarkNow() {
  if (!state.scan) { logLine("Scan keyframes first, then mark the timeline.", true); return; }
  setDetailsOpen(true);
  try {
    await syncMarkers(true);
  } catch (e) {
    logLine("Timeline markers failed: " + (e.message || e), true);
  }
}

async function ourMarkers(sequence) {
  const markers = await ppro.Markers.getMarkers(sequence);
  const ours = markers.getMarkers().filter((m) => String(m.getName()).indexOf(MARKER_PREFIX) === 0);
  return { markers, ours };
}

async function removeOurMarkers(project, sequence) {
  const { markers, ours } = await ourMarkers(sequence);
  if (!ours.length) return 0;
  transact(project, "Clear Krugmosh markers", (compound) => {
    for (const m of ours) compound.addAction(markers.createRemoveMarkerAction(m));
  });
  return ours.length;
}

/** Run one undoable edit the way Adobe's samples do; returns executeTransaction's result. */
function transact(project, label, build) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => build(compound), label);
  });
  return ok;
}

function markerColor(name) {
  const C = ppro.Constants && ppro.Constants.MarkerColor;
  const red = C && C.RED !== undefined ? C.RED : MARKER_RED;
  const green = C && C.GREEN !== undefined ? C.GREEN : MARKER_GREEN;
  return String(name).indexOf("remove") !== -1 ? red : green;
}

/** One marker per keyframe: red = will be removed, green = kept. */
async function syncMarkers(force) {
  const items = state.scan.keyframes
    .map((k) => ({ k, t: keyframeTimelineTime(k), remove: state.picked.has(kfKey(k)) }))
    .filter((x) => x.t != null);
  const sig = JSON.stringify(items.map((x) => [x.t.toFixed(4), x.remove]));
  if (sig === lastMarkerSig && !force) return;
  const red = items.filter((x) => x.remove).length;
  if (PREVIEW) {
    lastMarkerSig = sig;
    logLine(`(preview mode: would place ${items.length} timeline markers, ${red} red / ${items.length - red} green)`);
    return;
  }
  logLine(`Timeline markers: placing ${items.length} (${red} red, ${items.length - red} green)…`);
  const { project, sequence } = await getProjectAndSequence();
  const removed = await removeOurMarkers(project, sequence);
  if (removed) logLine(`  removed ${removed} old Krugmosh marker(s)`);

  const zero = ppro.TickTime.TIME_ZERO || ppro.TickTime.createWithSeconds(0);
  const makeAdd = (markers, x) => {
    const what = x.k.first ? "start" : x.k.cut ? "cut" : x.k.heal ? "heal point" : "scene change";
    return markers.createAddMarkerAction(
      MARKER_PREFIX + (x.remove ? "remove keyframe" : "keep keyframe"),
      ppro.Marker.MARKER_TYPE_COMMENT,
      ppro.TickTime.createWithSeconds(x.t),
      zero,
      `Krugmosh: clip ${x.k.clip + 1}, frame ${x.k.frame} (${what})`);
  };

  // All markers in one undo step; if Premiere refuses that, add them one at a time.
  let { markers } = await ourMarkers(sequence);
  const okAll = transact(project, "Krugmosh markers", (compound) => {
    for (const x of items) compound.addAction(makeAdd(markers, x));
  });
  let placed = (await ourMarkers(sequence)).ours.length;
  logLine(`  add (one step): ${okAll ? "ok" : "refused"}, ${placed} on timeline`);
  if (placed === 0 && items.length) {
    let fails = 0;
    for (const x of items) {
      markers = (await ourMarkers(sequence)).markers;
      if (!transact(project, "Krugmosh marker", (compound) => compound.addAction(makeAdd(markers, x)))) fails++;
    }
    placed = (await ourMarkers(sequence)).ours.length;
    logLine(`  add (one by one): ${items.length - fails} ok, ${fails} refused, ${placed} on timeline`,
            placed === 0);
  }

  // Colour them (a marker has to exist before its colour can be set).
  const fresh = await ourMarkers(sequence);
  if (fresh.ours.length) {
    const okColor = transact(project, "Krugmosh marker colours", (compound) => {
      for (const m of fresh.ours) compound.addAction(m.createSetColorByIndexAction(markerColor(m.getName())));
    });
    logLine(`  colours: ${okColor ? "ok" : "refused"}`);
  }
  if (placed) {
    lastMarkerSig = sig;
    logLine(`Timeline markers: ${placed} placed.`);
  } else {
    logLine("Timeline markers: Premiere didn't add any. Please send me these Details lines.", true);
  }
}

async function onShowMarkersChange() {
  saveSettings();
  if ($("showMarkers").checked) {
    lastMarkerSig = null;
    if (!state.scan) logLine("Markers appear after you scan keyframes.");
    scheduleMarkers();
  } else {
    await onClearMarkers();
  }
}

async function onClearMarkers() {
  clearTimeout(markerTimer);
  lastMarkerSig = null;
  if (PREVIEW) { logLine("(preview mode: would remove Krugmosh markers)"); return; }
  try {
    const { project, sequence } = await getProjectAndSequence();
    const n = await removeOurMarkers(project, sequence);
    logLine(`Removed ${n} Krugmosh marker(s) from the timeline.`);
  } catch (e) {
    logLine("Couldn't remove markers: " + (e.message || e), true);
  }
}

function onPick(k, on) {
  if (on) state.picked.add(kfKey(k)); else state.picked.delete(kfKey(k));
  // A cut keyframe and that cut's toggle are the same decision: keep them in sync.
  if (k.cut) {
    state.cuts[k.clip - 1] = on;
    renderClips(state.lastWarnings);
  }
  renderPicker();
}

function pickWhere(fn) {
  if (!state.scan) return;
  state.picked = new Set(state.scan.keyframes.filter((k) => !isLocked(k) && fn(k)).map(kfKey));
  state.scan.keyframes.filter((k) => k.cut).forEach((k) => {
    state.cuts[k.clip - 1] = state.picked.has(kfKey(k));
  });
  renderClips(state.lastWarnings);
  renderPicker();
}

function toggleBloomCut(i) {
  if (state.busy) return;
  state.bloomCuts[i] = state.bloomCuts[i] === false;
  renderClips(state.lastWarnings);
}

/** How many cuts will actually get a bloom (moshed + bloom chip on). */
function bloomCutCount() {
  let n = 0;
  for (let i = 0; i < state.clips.length - 1; i++) {
    if (state.cuts[i] !== false && state.bloomCuts[i] !== false) n++;
  }
  return n;
}

function toggleCut(i) {
  if (state.busy) return;
  state.cuts[i] = !state.cuts[i];
  // keep the picker's cut keyframe in step
  if (state.scan) {
    const k = state.scan.keyframes.find((x) => x.cut && x.clip === i + 1);
    if (k) { if (state.cuts[i]) state.picked.add(kfKey(k)); else state.picked.delete(kfKey(k)); }
  }
  renderClips(state.lastWarnings);
  renderPicker();
}

function renderRangeInfo() {
  const r = state.seqInfo && state.seqInfo.inOut;
  $("rangeInfo").textContent = !state.seqInfo ? "In/Out: click Use selection to read it"
    : r ? `In/Out: ${r[0].toFixed(2)}s – ${r[1].toFixed(2)}s`
    : "In/Out: not set on this sequence (whole selection is used)";
}

// ------------------------------------------------------------------ UI helpers

function setStatus(text, kind) {
  const el = $("statusText");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function setProgress(fraction, kind) {
  const bar = $("progressBar");
  bar.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + "%";
  bar.className = "progress-bar" + (kind ? " " + kind : "");
}

function logLine(msg, isErr) {
  const line = document.createElement("div");
  line.textContent = msg;
  if (isErr) {
    line.className = "err";
    setDetailsOpen(true);
  }
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}

function clearLog() { $("log").innerHTML = ""; }

function setDetailsOpen(open) {
  $("log").className = "log" + (open ? "" : " hidden");
  $("btnDetails").textContent = (open ? "▾" : "▸") + " Details";
}

function fmtSec(s) {
  if (s == null) return "full";
  return s.toFixed(2) + "s";
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function startTimer() {
  state.startedAt = Date.now();
  $("elapsed").textContent = "0:00";
  state.timer = setInterval(() => {
    $("elapsed").textContent = fmtElapsed(Date.now() - state.startedAt);
  }, 500);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** The panel's "buttons" are plain elements (Premiere restyles real <button>s), so a
 *  disabled one gets the is-disabled class, and clicks on it are ignored. */
function syncDisabled() {
  document.querySelectorAll('[role="button"]').forEach((b) => {
    const off = !!b.disabled;
    const has = (" " + b.className + " ").indexOf(" is-disabled ") !== -1;
    if (off && !has) b.className = (b.className + " is-disabled").trim();
    if (!off && has) b.className = b.className.replace(/\s*is-disabled/g, "");
  });
}

function ownerButton(el) {
  for (let n = el; n && n !== document; n = n.parentNode) {
    if (n.getAttribute && n.getAttribute("role") === "button") return n;
  }
  return null;
}

document.addEventListener("click", (e) => {
  const b = ownerButton(e.target);
  if (b && b.disabled) { e.stopPropagation(); e.preventDefault(); }
}, true);

/** A cut needs 2 clips; with Bloom ticked a single clip is enough. */
function minClips() { return $("bloomOn").checked ? 1 : 2; }

/** What stops a mosh with the clips loaded right now (null = good to go). */
function moshProblem() {
  const n = state.clips.length;
  if ($("targetOn").checked) {
    const t = state.target;
    if (!t || !t.pick) return "Targeted mosh: put the playhead on the object, click Pick object, click the object, then Confirm.";
    if (!t.confirmed) return "Targeted mosh: click Confirm object when the selection looks right.";
    if (!state.clips.some((c) => clipKey(c) === t.clipKey)) {
      return "Targeted mosh: the picked clip isn't selected any more. Select it again or pick again.";
    }
    return null;
  }
  const bloom = $("bloomOn").checked;
  if (n === 0) return "Nothing usable is selected on the timeline. Select the clips first.";
  if (n === 1 && !bloom) {
    return "Only 1 clip is selected. Select both clips around the cut (Shift-click), " +
           "or tick Bloom to bloom just this clip.";
  }
  if (n === 1 && bloom && state.bloomWhich === "after") {
    return "Only 1 clip is selected, so there's no cut to bloom after. Select both clips " +
           "around the cut (Shift-click), or use Playhead / Strongest motion.";
  }
  if (bloom && state.bloomWhich === "playhead" && !(state.bloomPoint && state.clips[state.bloomPoint.clip])) {
    return "Click Use playhead to choose the frame to bloom.";
  }
  if (state.mode === "manual" && !scanIsFresh()) {
    return "Pick keyframes mode: click Scan keyframes (the clips or settings changed since the last scan).";
  }
  return null;
}

function updateMoshButton() {
  const btn = $("btnMosh");
  if (state.busy) {
    btn.textContent = state.cancelRequested ? "CANCELLING…" : "CANCEL";
    btn.className = "btn-mosh cancel";
    btn.disabled = state.cancelRequested;
  } else {
    btn.textContent = "MOSH IT";  // non-breaking space: Premiere collapsed the normal one
    btn.className = "btn-mosh";
    // MOSH IT re-reads the timeline selection on every click, so it only needs the
    // helper; anything else missing is explained when you click.
    btn.disabled = !state.helperOk;
    btn.title = state.clips.length ? (moshProblem() || "") : "Uses the clips selected on the timeline";
    renderBloomNote(state.clips.length === 1 && $("bloomOn").checked && state.bloomWhich === "after");
  }
  $("app").className = "app" + (state.busy ? " busy" : "");
  ["trimA", "trimB", "quant", "healAfter", "gop", "bloom", "bloomAt", "bloomOn", "bloomSmooth", "bwAuto", "bwAfter", "bwPlayhead",
   "btnUsePlayhead", "smearFrames", "smearRepeat", "acidOn", "sat", "contrast", "brightness", "hueJump", "spin", "detail", "objectsOn", "stPrism", "stPure", "stTint",
   "posterize", "neon", "btnAcidPreset", "onlyJoins", "useRange", "keepAvi", "audioOn", "targetOn", "btnPick", "btnPickUndo", "btnPickClear",
   "btnConfirm", "pickSens", "trail", "blockSize", "bleed", "btnRefresh",
   "btnReset", "modeAuto", "modeManual", "srcTimeline", "srcOriginal", "pickAll", "pickCuts", "pickNone", "showMarkers",
   "btnClearMarkers", "btnMarkNow"].forEach((id) => {
    $(id).disabled = state.busy;
  });
  $("btnScan").disabled = state.busy || !state.helperOk;
  document.querySelectorAll(".step, .num").forEach((b) => { b.disabled = state.busy; });
  syncDisabled();
}

function renderClips(warnings) {
  state.lastWarnings = warnings;
  const list = $("clipList");
  list.innerHTML = "";
  if (!state.clips.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.innerHTML = "Select 2+ clips with a cut between them (or 1 clip to just bloom it), " +
                  "then click <b>Use selection</b>.";
    list.appendChild(d);
  }
  state.clips.forEach((c, i) => {
    if (i > 0) {
      const on = state.cuts[i - 1] !== false;
      const jr = document.createElement("div");
      jr.className = "join-row";
      const j = document.createElement("div");
      j.className = "join" + (on ? "" : " off");
      j.textContent = on ? "▼ mosh here ▼" : "── hard cut ──";
      j.title = on ? "Click to make this a normal hard cut" : "Click to mosh this cut";
      j.addEventListener("click", () => toggleCut(i - 1));
      jr.appendChild(j);
      // Bloom chip: which cuts get the bloom (Strongest motion / After cut modes)
      if (on && $("bloomOn").checked && state.bloomWhich !== "playhead") {
        const bon = state.bloomCuts[i - 1] !== false;
        const chip = document.createElement("span");
        chip.className = "bloom-chip" + (bon ? " on" : "");
        chip.textContent = bon ? "✿ bloom" : "✿ no bloom";
        chip.title = bon ? "This cut gets the bloom. Click to skip it." : "Click to bloom this cut.";
        chip.addEventListener("click", (e) => { e.stopPropagation(); toggleBloomCut(i - 1); });
        jr.appendChild(chip);
      }
      list.appendChild(jr);
    }
    const row = document.createElement("div");
    row.className = "clip";
    row.innerHTML =
      '<span class="clip-idx"></span><span class="clip-name"></span><span class="clip-meta"></span>';
    row.children[0].textContent = String(i + 1);
    row.children[1].textContent = c.name;
    row.children[1].title = c.path;
    row.children[2].textContent = "V" + (c.track + 1) + " · " + fmtSec(c.duration);
    // A plain clickable span (like the ✿ chips): Premiere's tiny <button>s didn't respond.
    const x = document.createElement("span");
    x.className = "clip-x" + (state.busy ? " disabled" : "");
    x.textContent = "✕";
    x.title = "Remove from this mosh (Use selection brings it back)";
    x.addEventListener("click", (e) => { e.stopPropagation(); onRemoveClip(i); });
    row.appendChild(x);
    list.appendChild(row);
  });
  (warnings || []).forEach((w) => {
    const d = document.createElement("div");
    d.className = "warn";
    d.textContent = "⚠ " + w;
    list.appendChild(d);
  });
  updateMoshButton();
}

/** Hover help: shows each control's data-help text in the help box. */
function bindHelp() {
  const box = $("helpBox");
  const idle = box.textContent;
  document.querySelectorAll("[data-help]").forEach((el) => {
    el.setAttribute("title", el.getAttribute("data-help"));
    el.addEventListener("mouseenter", () => {
      box.textContent = el.getAttribute("data-help");
      box.className = "help active";
    });
    el.addEventListener("mouseleave", () => {
      box.textContent = idle;
      box.className = "help";
    });
  });
}

function showResult(result, jobId, placedText) {
  state.lastResultJob = jobId;
  $("resultCard").className = "section result";

  const img = $("previewImg");
  const labels = $("previewLabels");
  labels.innerHTML = "";
  if (result.preview) {
    img.src = HELPER + "/jobs/" + jobId + "/preview.png?t=" + Date.now();
    img.className = "preview-img";
    const offs = result.previewOffsets || [];
    for (let r = 0; r < 2; r++) {
      const row = document.createElement("div");
      row.className = "preview-row";
      for (let c = 0; c < 4; c++) {
        const cell = document.createElement("div");
        cell.className = "preview-cell";
        const o = offs[r * 4 + c];
        if (o !== undefined) {
          const b = document.createElement("span");
          b.className = "badge" + (o === 0 ? " cut" : "");
          b.textContent = o === 0 ? "CUT" : (o > 0 ? "+" : "") + o;
          cell.appendChild(b);
        }
        row.appendChild(cell);
      }
      labels.appendChild(row);
    }
  } else {
    img.removeAttribute("src");
    img.className = "preview-img hidden";
  }

  const info = $("resultInfo");
  info.innerHTML = "";
  const parts = [
    ["Frames", result.frames + " (" + result.seconds.toFixed(2) + "s)"],
    ["Keyframes removed", String(result.iframes_removed)],
    ...(result.bloomed ? [["Bloom", "+" + result.bloomed + " frames"]] : []),
    ...(result.smeared ? [["Smear boost", "+" + result.smeared + " frames"]] : []),
    ["Audio", result.audio ? "included, in sync" : "none"],
    ["Size", result.width + "×" + result.height + " @ " + result.fps.toFixed(3) + " fps"],
  ];
  if (placedText) parts.push(["Timeline", placedText]);
  parts.forEach(([k, v]) => {
    const line = document.createElement("div");
    line.innerHTML = k + ": <b></b>";
    line.querySelector("b").textContent = v;
    info.appendChild(line);
  });
}

// ------------------------------------------------------------------ helper

// The helper version this panel needs (matches VERSION in mosh_server.py).
const HELPER_VERSION = 11;

async function checkHelper() {
  let ok = false;
  let outdated = false;
  let error = null;
  for (const url of HELPER_URLS) {
    try {
      const r = await fetch(url + "/health");
      const j = JSON.parse(await r.text());
      if (j.ok && (j.version || 1) < HELPER_VERSION) {
        outdated = true;
        HELPER = url;
        error = `helper is an older version (v${j.version || 1}, panel needs v${HELPER_VERSION})`;
        break;
      }
      if (j.ok) { ok = true; HELPER = url; break; }
      error = "helper reports: " + (j.error || "not ok");
    } catch (e) {
      error = (e && (e.message || e.toString())) || "unknown error";
    }
  }
  // Log the reason (once per distinct error) so problems can be diagnosed.
  if (!ok && error !== lastHelperError) logLine("Helper check failed: " + error);
  if (ok && lastHelperError) logLine("Helper connected at " + HELPER);
  lastHelperError = ok ? null : error;

  state.helperOk = ok;
  $("helperPill").className = "pill " + (ok ? "pill-on" : "pill-off");
  $("helperText").textContent = ok ? "helper online" : outdated ? "restart helper" : "offline";
  $("offlineBanner").className = "banner" + (ok ? " hidden" : "");
  $("bannerText").innerHTML = outdated
    ? "The running helper is an <b>older version</b>. Run <b>Krugmosh-Setup.exe</b> again to restart it."
    : "The helper isn't running.";
  $("btnStartHelper").className = "btn-small" + (outdated ? " hidden" : "");
  updateMoshButton();
}

/**
 * Where the helper lives, as written by Krugmosh-Setup.exe to
 * %APPDATA%\Krugmosh\home.txt (the .ccx from GitHub doesn't know the folder).
 */
function helperHomeFromFile() {
  try {
    const os = require("os");
    const fs = require("fs");
    const file = os.homedir() + "\\AppData\\Roaming\\Krugmosh\\home.txt";
    for (const p of [file, "file:" + file]) {
      try {
        const txt = String(fs.readFileSync(p, { encoding: "utf-8" })).trim();
        if (txt) return txt.replace(/^﻿/, "").replace(/[\\/]+$/, "");
      } catch (e) { /* try the next form */ }
    }
  } catch (e) { /* not available */ }
  return "";
}

/** Launch the windowless helper (krugmosh_helper.pyw) from inside Premiere. */
async function onStartHelper() {
  const btn = $("btnStartHelper");
  btn.disabled = true;
  syncDisabled();
  try {
    const uxp = require("uxp");
    // Installed copy: config.js says where the krugmosh folder is. While developing the
    // panel lives in krugmosh\panel, so the helper is one folder up.
    let root = String(window.KRUGMOSH_HOME || "").replace(/[\\/]+$/, "");
    if (!root) root = helperHomeFromFile();
    if (!root) {
      const folder = await uxp.storage.localFileSystem.getPluginFolder();
      root = String(folder.nativePath).replace(/[\\/]+$/, "").replace(/[\\/]panel$/i, "");
    }
    const target = root + "\\krugmosh_helper.pyw";
    const res = await uxp.shell.openPath(target, "Starts the Krugmosh helper in the background.");
    if (res) throw new Error(res);
    logLine("Starting the helper in the background…");
    for (let i = 0; i < 10 && !state.helperOk; i++) {
      await sleep(700);
      await checkHelper();
    }
    if (!state.helperOk) {
      logLine("The helper didn't come up. Check helper.log in the Krugmosh app folder.", true);
    }
  } catch (e) {
    logLine("Premiere couldn't start the helper (" + (e.message || e) + "). " +
            "Double-click krugmosh_helper.pyw in the Krugmosh app folder instead, " +
            "or run Krugmosh-Setup.exe once.", true);
  } finally {
    btn.disabled = false;
    syncDisabled();
  }
  updateMoshButton();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Turn the helper's log lines into a friendly step name + progress fraction. */
function describeStep(log, nClips, keepAvi, kind) {
  const total = kind === "scan" ? nClips + 0.5 : nClips + 2 + (keepAvi ? 0.3 : 0);
  let done = 0;
  let label = "Starting…";
  for (const line of log) {
    let m = line.match(/^Encoding clip (\d+)\/(\d+)/);
    if (m && kind === "scan") { label = `Scanning clip ${m[1]} of ${m[2]}…`; done = Number(m[1]) - 1; continue; }
    if (m) { label = `Encoding clip ${m[1]} of ${m[2]}…`; done = Number(m[1]) - 1; continue; }
    if (line.startsWith("Deleted")) { label = "Removing keyframes…"; done = nClips; continue; }
    if (line.startsWith("Converting")) { label = "Converting to ProRes…"; done = nClips + (keepAvi ? 0.3 : 0); continue; }
    if (line.startsWith("Making preview")) { label = "Making preview…"; done = nClips + 1.6 + (keepAvi ? 0.3 : 0); }
  }
  return { label, fraction: 0.03 + 0.9 * (done / total) };
}

async function runHelperJob(body, kind) {
  kind = kind || "mosh";
  const r = await fetch(HELPER + "/" + kind, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const start = await r.json().catch(() => ({}));
  const job = start && start.job;
  if (!r.ok || !job) {
    throw new Error(r.status === 404
      ? "The helper doesn't support this yet. Run Krugmosh-Setup.exe again to restart it."
      : "The helper didn't start the job" + (start && start.error ? ": " + start.error : "."));
  }
  state.job = job;
  let shown = 0;
  for (;;) {
    await sleep(350);
    const s = await (await fetch(HELPER + "/jobs/" + job)).json().catch(() => null);
    if (!s || !Array.isArray(s.log)) {
      throw new Error("Lost track of the job (was the helper restarted?). Try again.");
    }
    for (; shown < s.log.length; shown++) {
      logLine(s.log[shown], s.log[shown].startsWith("ERROR"));
    }
    if (s.state === "running") {
      const step = describeStep(s.log, body.clips.length, body.keepAvi, kind);
      if (!state.cancelRequested) setStatus(step.label, "busy");
      setProgress(step.fraction);
    }
    if (s.state === "done") return { result: s.result, job };
    if (s.state === "cancelled") throw new Error("CANCELLED");
    if (s.state === "error") throw new Error(s.error || "helper failed");
  }
}

// ------------------------------------------------------------------ Premiere

async function getProjectAndSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Open a project first.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open a sequence first.");
  return { project, sequence };
}

/** Selected *video* clips, sorted by timeline position. */
async function readSelection() {
  if (PREVIEW) return previewSelection();

  const { project, sequence } = await getProjectAndSequence();

  // Walk the VIDEO tracks only and keep selected clips. (The timeline selection
  // also contains the linked audio clips, which must not be moshed as extra copies.)
  const items = [];
  const seen = new Set();
  const vCount = await sequence.getVideoTrackCount();
  for (let t = 0; t < vCount; t++) {
    const track = await sequence.getVideoTrack(t);
    const trackItems = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const ti of trackItems) {
      if (!(await ti.getIsSelected())) continue;
      const st = await ti.getStartTime();
      const key = t + ":" + st.ticks;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ item: ti, track: t, start: st });
    }
  }

  const clips = [];
  const warnings = [];
  for (const { item, track, start } of items) {
    const end = await item.getEndTime();
    const inPt = await item.getInPoint();
    const name = await item.getName();
    const speed = await item.getSpeed();
    const projectItem = await item.getProjectItem();
    let path = "";
    try {
      const clipItem = ppro.ClipProjectItem.cast(projectItem);
      path = cleanPath(await clipItem.getMediaFilePath());
    } catch (e) { path = ""; }
    if (!path && state.source === "original") {
      // Without a media file there's nothing to read in Original media mode. "As on timeline"
      // renders it in Premiere, so nested sequences / graphics / titles work there.
      warnings.push(`"${name}" has no media file (nested sequence, graphic or title), so ` +
                    `Original media mode can't use it. Switch Clip source to "As on timeline".`);
      continue;
    }
    if (Math.abs(speed - 1) > 0.001 && state.source === "original") {
      warnings.push(`"${name}" is at ${Math.round(speed * 100)}% speed; Original media mode moshes it at 100%. Use "As on timeline" to keep the speed.`);
    }
    clips.push({
      name, path, track,
      timelineStart: start.seconds,
      start: inPt.seconds,
      duration: end.seconds - start.seconds,
    });
  }
  clips.sort((a, b) => a.timelineStart - b.timelineStart || a.track - b.track);
  removeOverlaps(clips, warnings);

  // Sequence frame size / rate so the moshed clip matches the timeline.
  let seqInfo = { outputDir: null, fps: null, size: null, inOut: null };
  try {
    // Sequence In/Out. When none are set Premiere reports the whole sequence (0 → end).
    const inPt = (await sequence.getInPoint()).seconds;
    const outPt = (await sequence.getOutPoint()).seconds;
    const endPt = (await sequence.getEndTime()).seconds;
    const isSet = inPt > 0.001 || (outPt > 0 && outPt < endPt - 0.001);
    if (isSet && outPt > inPt) seqInfo.inOut = [inPt, outPt];
  } catch (e) { /* In/Out not available */ }
  try {
    const settings = await sequence.getSettings();
    seqInfo.fps = settings.getVideoFrameRate().value;
    const rect = await settings.getVideoFrameRect();
    seqInfo.size = [Math.round(rect.width), Math.round(rect.height)];
  } catch (e) { /* fall back to the first clip's settings */ }
  try {
    const p = cleanPath(project.path);
    if (p) seqInfo.outputDir = p.replace(/[\\/][^\\/]*$/, "") + "\\Krugmosh Renders";
  } catch (e) { /* default dir */ }

  return { clips, warnings, seqInfo };
}

/**
 * Clips stacked on several video tracks overlap in time. Moshing each one at its full
 * length would play the overlapping footage twice (the video jumps back). Make every
 * clip end where the next one starts, so each moment of the timeline is used once.
 * Clips starting at the same moment: only the top one (the one you see) is kept.
 */
function removeOverlaps(clips, warnings) {
  for (let i = clips.length - 2; i >= 0; i--) {
    if (Math.abs(clips[i + 1].timelineStart - clips[i].timelineStart) < 0.001) {
      // sorted by track: i+1 is the higher one. If the lower one is longer, its end
      // still shows after the top one finishes.
      const top = clips[i + 1], low = clips[i];
      const lowEnd = low.fullEnd || low.timelineStart + low.duration;
      if (lowEnd > top.timelineStart + top.duration + 0.001) top.fullEnd = Math.max(top.fullEnd || 0, lowEnd);
      clips.splice(i, 1);
    }
  }
  let trimmed = 0;
  for (let i = 0; i < clips.length - 1; i++) {
    const c = clips[i];
    const room = clips[i + 1].timelineStart - c.timelineStart;
    if (c.duration > room + 0.001) {
      c.fullEnd = c.timelineStart + c.duration;  // what's left of it plays after the next clip
      c.duration = room;
      trimmed++;
    }
  }
  if (trimmed) {
    warnings.push(`${trimmed} clip(s) overlap clips on other tracks; each part of the timeline is used once.`);
  }
}

/** Strip Windows long-path prefixes (\\?\ or \\?\UNC\) so paths compare equal. */
function cleanPath(p) {
  return String(p || "").replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}
function normPath(p) { return cleanPath(p).replace(/\\/g, "/").toLowerCase(); }
function baseName(p) { return normPath(p).split("/").pop(); }

/** Find a clip in the project by its media path (falls back to file name). */
async function findProjectItemByPath(folder, target, depth) {
  const targetName = baseName(target);
  let byName = null;
  async function walk(f, d) {
    const children = await f.getItems();
    for (const child of children) {
      try {
        const clip = ppro.ClipProjectItem.cast(child);
        const p = await clip.getMediaFilePath();
        if (normPath(p) === normPath(target)) return child;
        if (!byName && p && baseName(p) === targetName) byName = child;
      } catch (e) { /* not a clip */ }
      if (d > 0) {
        try {
          const found = await walk(ppro.FolderItem.cast(child), d - 1);
          if (found) return found;
        } catch (e) { /* not a bin */ }
      }
    }
    return null;
  }
  return (await walk(folder, depth)) || byName;
}

/** Import the moshed file and put it on the track above the selected clips. */
/** First audio track with nothing on it between t0 and t1 (seconds), or -1. */
async function freeAudioTrack(sequence, t0, t1) {
  const n = await sequence.getAudioTrackCount();
  for (let i = 0; i < n; i++) {
    const track = await sequence.getAudioTrack(i);
    let busy = false;
    for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      const s = (await item.getStartTime()).seconds;
      const e = (await item.getEndTime()).seconds;
      if (s < t1 - 1e-3 && e > t0 + 1e-3) { busy = true; break; }
    }
    if (!busy) return i;
  }
  return -1;
}

async function placeResult(outputPath, seconds, anchorIdx) {
  if (PREVIEW) {
    logLine("(preview mode: would import into Premiere now)");
    return "preview mode, not placed";
  }
  const { project, sequence } = await getProjectAndSequence();
  const ok = await project.importFiles([outputPath], true);
  if (!ok) throw new Error("Premiere could not import " + outputPath);

  const root = await project.getRootItem();
  const projectItem = await findProjectItemByPath(root, outputPath, 3);
  if (!projectItem) throw new Error("Imported, but couldn't find the clip in the project panel.");

  const anchored = anchorIdx !== undefined && state.clips[anchorIdx];
  const first = anchored ? state.clips[anchorIdx] : state.clips[0];
  const t0 = first.timelineStart;
  const t1 = t0 + (seconds || 0);
  let vTrack = (anchored ? first.track : Math.max(...state.clips.map((c) => c.track))) + 1;
  const vCount = await sequence.getVideoTrackCount();
  const aCount = await sequence.getAudioTrackCount();
  // Audio must never overwrite existing audio: use an audio track that's empty there.
  let aTrack = await freeAudioTrack(sequence, t0, t1);
  let insert = vTrack >= vCount;            // inserting is what creates new tracks
  if (aTrack === -1) {
    // no free audio track: put both on brand-new tracks (an insert on new, empty
    // tracks shifts nothing)
    aTrack = aCount;
    vTrack = Math.max(vTrack, vCount);
    insert = true;
  }
  const time = ppro.TickTime.createWithSeconds(t0);
  const editor = ppro.SequenceEditor.getEditor(sequence);

  let placed = false;
  project.lockedAccess(() => {
    placed = project.executeTransaction((compound) => {
      const action = insert
        ? editor.createInsertProjectItemAction(projectItem, time, vTrack, aTrack, true)
        : editor.createOverwriteItemAction(projectItem, time, vTrack, aTrack);
      compound.addAction(action);
    }, "Krugmosh");
  });
  if (!placed) throw new Error("Couldn't place the clip on the timeline (it is in the project panel).");
  const where = `V${vTrack + 1}` + (state.lastHadAudio ? ` + A${aTrack + 1}` : "") +
                ` at ${t0.toFixed(2)}s`;
  logLine("Placed on " + where);
  return where;
}

// ------------------------------------------------------------------ preview mode

async function previewSelection() {
  // The helper knows where the test clips live on disk.
  const base = (await (await fetch(HELPER + "/test-dir")).json()).dir + "\\";
  return {
    clips: [
      { name: "a.mp4 (preview)", path: base + "a.mp4", track: 0, timelineStart: 0, start: 0, duration: 3 },
      { name: "b.mp4 (preview)", path: base + "b.mp4", track: 0, timelineStart: 3, start: 0, duration: 3 },
      { name: "c.mp4 (preview)", path: base + "c.mp4", track: 0, timelineStart: 6, start: 0, duration: 3 },
      { name: "d.mp4 (preview)", path: base + "d.mp4", track: 0, timelineStart: 9, start: 0, duration: 4 },
    ],
    warnings: ["Preview mode: not running inside Premiere Pro."],
    seqInfo: { outputDir: base + "preview-renders", fps: 29.97, size: [640, 360], inOut: [2.0, 5.5] },
  };
}

// ------------------------------------------------------------------ actions

/** Identifies one clip on the timeline. */
function clipKey(c) { return [c.path, c.track, c.timelineStart].join("|"); }

/** × on a clip row: drop it from the mosh (it stays selected on the timeline). */
function onRemoveClip(i) {
  if (state.busy || !state.clips[i]) return;
  state.removed.add(clipKey(state.clips[i]));
  state.clips.splice(i, 1);
  // the cut before it (or after it, for the first clip) goes too
  const cutIdx = i > 0 ? i - 1 : 0;
  if (state.cuts.length) state.cuts.splice(cutIdx, 1);
  if (state.bloomCuts.length) state.bloomCuts.splice(cutIdx, 1);
  if (state.bloomPoint) {
    if (state.bloomPoint.clip === i) state.bloomPoint = null;
    else if (state.bloomPoint.clip > i) state.bloomPoint.clip -= 1;
  }
  const warnings = [];
  if (state.clips.length === 1) warnings.push("Only 1 clip left. 1 clip can only be bloomed.");
  if (state.clips.length === 0) warnings.push("All clips removed. Click Use selection to start again.");
  renderClips(warnings);
  renderPicker();
  renderBloomPoint();
  setStatus(state.clips.length ? `Ready · ${state.clips.length} clip(s)` : "No clips", state.clips.length ? "ok" : "");
}

function clipsSignature(clips) {
  return JSON.stringify(clips.map((c) => [c.path, c.track, c.timelineStart, c.start, c.duration]));
}

/**
 * Read the timeline selection into the panel. Returns how many clips were loaded.
 * auto: an automatic re-read (MOSH IT / Scan / Use playhead). If the same clips are still
 * selected, nothing is reset (cuts, bloom chips, render, chosen frame stay).
 */
async function onUseSelection(opts) {
  const auto = !!(opts && opts.auto);
  try {
    if (!auto) setStatus("Reading selection…", "busy");
    const read = await readSelection();
    const { warnings, seqInfo } = read;
    // Clicking Use selection yourself starts fresh; automatic re-reads keep the clips
    // you removed with × out of the list.
    if (!auto) state.removed = new Set();
    state.selClips = read.clips;                     // everything selected (= what a render holds)
    const clips = read.clips.filter((c) => !state.removed.has(clipKey(c)));
    const sameClips = clipsSignature(clips) === clipsSignature(state.clips);
    if (auto && sameClips && state.clips.length) {
      state.seqInfo = seqInfo;
      return clips.length;
    }
    state.clips = clips;
    state.render = null;   // re-render next time: effects may have changed
    if (!sameClips) state.bloomPoint = null;
    state.seqInfo = seqInfo;
    if (!sameClips || state.cuts.length !== Math.max(0, clips.length - 1)) {
      state.cuts = clips.slice(1).map(() => true);   // every cut moshed by default
      state.bloomCuts = clips.slice(1).map(() => true);
    }
    if (clips.length === 0) warnings.push("No video clips selected.");
    else if (clips.length === 1) warnings.push("Only 1 clip is selected. For a cut, select both clips around it (Shift-click); 1 clip can only be bloomed.");
    renderClips(warnings);
    renderRangeInfo();
    renderPicker();
    renderBloomPoint();
    $("outDir").textContent = "Saves to: " + (seqInfo.outputDir || "Videos\\Krugmosh Renders");
    $("outDir").title = seqInfo.outputDir || "";
    setStatus(clips.length >= 2 ? `Ready · ${clips.length} clips`
              : clips.length === 1 ? "Ready · 1 clip (bloom only)" : "No clips selected",
              clips.length ? "ok" : "");
    return clips.length;
  } catch (e) {
    setStatus("Couldn't read selection", "err");
    logLine(String(e.message || e), true);
    return 0;
  }
}

async function onCancel() {
  if (!state.job || state.cancelRequested) return;
  state.cancelRequested = true;
  updateMoshButton();
  setStatus("Cancelling…", "busy");
  try { await fetch(HELPER + "/jobs/" + state.job + "/cancel", { method: "POST" }); } catch (e) { /* ignore */ }
}

/** Shared busy/progress/cancel handling for scan and mosh jobs. */
async function runBusy(work) {
  if (state.busy) return onCancel();
  state.busy = true;
  state.cancelRequested = false;
  state.job = null;
  updateMoshButton();
  renderPicker();
  clearLog();
  setProgress(0.02);
  setStatus("Starting…", "busy");
  startTimer();
  try {
    await work();
  } catch (e) {
    const msg = String(e.message || e);
    if (msg === "CANCELLED") {
      setStatus("Cancelled", "");
      setProgress(0);
    } else {
      setStatus("Failed (see details)", "err");
      setProgress(1, "err");
      logLine(msg, true);
    }
  } finally {
    stopTimer();
    state.busy = false;
    state.cancelRequested = false;
    updateMoshButton();
    renderPicker();
  }
}

// ------------------------------------------------------------------ clip source

function setSource(src, silent) {
  state.source = src === "original" ? "original" : "timeline";
  $("srcTimeline").className = "seg-btn" + (state.source === "timeline" ? " on" : "");
  $("srcOriginal").className = "seg-btn" + (state.source === "original" ? " on" : "");
  if (!silent) saveSettings();
  refreshScanState();
}

/** Video clip positions inside a sequence, sorted like state.clips. */
async function videoClipSpans(sequence) {
  const spans = [];
  const n = await sequence.getVideoTrackCount();
  for (let t = 0; t < n; t++) {
    const track = await sequence.getVideoTrack(t);
    for (const ti of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      spans.push({ track: t, start: (await ti.getStartTime()).seconds, end: (await ti.getEndTime()).seconds });
    }
  }
  spans.sort((a, b) => a.start - b.start || a.track - b.track);
  return spans;
}

/**
 * Have Premiere render the selected clips exactly as they look on the timeline
 * (effects, crop, scale, speed...). Makes a temporary subsequence of the selection,
 * exports it with a ProRes "match source" preset, then deletes the subsequence.
 * Reused until the selection is read again.
 */
async function renderSelection() {
  // A render covers everything selected, so removing a clip with × doesn't need a new one.
  const key = clipsSignature(state.selClips && state.selClips.length ? state.selClips : state.clips);
  if (state.render && state.render.key === key) {
    logLine("Using the render from earlier (click Use selection after changing effects).");
    return state.render;
  }
  setStatus("Rendering selection in Premiere…", "busy");
  logLine("Rendering the selected clips as they look on the timeline…");

  const preset = await (await fetch(HELPER + "/preset")).json();
  if (!preset.path) throw new Error("No export preset: " + (preset.error || "unknown"));
  const out = (await (await fetch(HELPER + "/render-path")).json()).path;

  const { project, sequence } = await getProjectAndSequence();
  const sub = await sequence.createSubsequence(true);
  if (!sub) throw new Error("Premiere couldn't make a subsequence from the selection. Is it still selected?");
  try {
    // Making a subsequence can switch the timeline to it; switch back.
    try { await project.setActiveSequence(sequence); } catch (e) { /* ignore */ }

    // Where each selected clip landed inside the subsequence (= where it is in the render).
    // The subsequence holds everything selected on the timeline (also clips removed with ×).
    const spans = await videoClipSpans(sub);
    const all = state.selClips && state.selClips.length ? state.selClips : state.clips;
    const offsets = {};
    if (spans.length === all.length) {
      all.forEach((c, i) => { offsets[clipKey(c)] = spans[i].start; });
    } else {
      logLine(`(subsequence has ${spans.length} video clips for ${all.length} selected; using timeline offsets)`);
      const t0 = Math.min(...all.map((c) => c.timelineStart));
      all.forEach((c) => { offsets[clipKey(c)] = c.timelineStart - t0; });
    }

    const ok = await ppro.EncoderManager.getManager().exportSequence(
      sub, ppro.Constants.ExportType.IMMEDIATELY, out, preset.path, true);
    if (!ok) throw new Error("Premiere's export of the selection failed.");
    logLine("Render done: " + out.split("\\").pop());
    state.render = { key, path: out, offsets };
    return state.render;
  } finally {
    // Remove the temporary subsequence from the project.
    try {
      const item = await sub.getProjectItem();
      const bin = item.getParentBin();
      const removed = transact(project, "Remove Krugmosh temp sequence",
                               (c) => c.addAction(bin.createRemoveItemAction(item)));
      if (!removed) logLine("Note: couldn't delete the temporary subsequence; you can delete it from the Project panel.");
    } catch (e) {
      logLine("Note: couldn't delete the temporary subsequence (" + (e.message || e) + ").");
    }
    try { await project.setActiveSequence(sequence); } catch (e) { /* ignore */ }
  }
}

/** The clips to send to the helper: the Premiere render (default) or the raw media. */
async function jobClips() {
  if (PREVIEW || state.source === "original") {
    const noFile = state.clips.find((c) => !c.path);
    if (noFile) {
      throw new Error(`"${noFile.name}" has no media file (nested sequence, graphic or title). ` +
                      `Switch Clip source to "As on timeline" to mosh it.`);
    }
    return {
      rendered: false,
      clips: state.clips.map((c) => ({ path: c.path, start: c.start, duration: c.duration })),
    };
  }
  const r = await renderSelection();
  // In the render, the end of a clip that was overlapped by a shorter clip on a higher
  // track plays after that clip: give it to the piece before it, so nothing is lost.
  const all = state.selClips && state.selClips.length ? state.selClips : state.clips;
  const dur = {};
  let cover = -Infinity;
  all.forEach((c, i) => {
    cover = Math.max(cover, c.fullEnd || c.timelineStart + c.duration);
    const next = i + 1 < all.length ? all[i + 1].timelineStart : Infinity;
    dur[clipKey(c)] = Math.max(c.duration, Math.min(next, cover) - c.timelineStart);
  });
  return {
    rendered: true,
    clips: state.clips.map((c) => ({ path: r.path, start: r.offsets[clipKey(c)],
                                     duration: dur[clipKey(c)] || c.duration })),
  };
}

async function commonBody() {
  const s = readSettings();
  const src = await jobClips();
  return {
    clips: src.clips, rendered: src.rendered,
    quant: s.quant, trimB: s.trimB, healAfter: s.healAfter, cuts: state.cuts.slice(),
    gop: s.gop,
    fps: state.seqInfo && state.seqInfo.fps,
    size: state.seqInfo && state.seqInfo.size,
  };
}

async function onScan() {
  if (state.busy) return;
  // Always scan what is selected on the timeline right now.
  if (!(await onUseSelection({ auto: true }))) {
    logLine("Select the clips on the timeline first.", true);
    return;
  }
  return runBusy(async () => {
    const body = await commonBody();
    const key = scanKey();   // after rendering: the scan belongs to this render
    const { result, job } = await runHelperJob(body, "scan");
    const old = state.picked;
    const hadScan = !!state.scan;
    state.scan = { key, job, keyframes: result.keyframes };
    // Default ticks: same rule as Auto mode (every removable keyframe; cuts follow their
    // toggle). Re-scans keep earlier ticks for keyframes that still exist.
    state.picked = new Set();
    for (const k of result.keyframes) {
      if (isLocked(k)) continue;
      const want = k.cut ? state.cuts[k.clip - 1] !== false
        : hadScan ? old.has(kfKey(k)) : true;
      if (want) state.picked.add(kfKey(k));
    }
    renderPicker();
    setProgress(1, "ok");
    const n = result.keyframes.filter((k) => !isLocked(k)).length;
    setStatus(`Scanned · ${n} removable keyframe(s)`, "ok");
  });
}

async function onMosh() {
  if (state.busy) return onCancel();
  // Always mosh what is selected on the timeline right now.
  await onUseSelection({ auto: true });
  const problem = moshProblem();
  if (problem) {
    setStatus("Can't mosh yet", "err");
    logLine(problem, true);
    return;
  }
  if ($("targetOn").checked) return runTargeted();
  return runBusy(async () => {
    const s = readSettings();
    const body = Object.assign(await commonBody(), {
      trimA: s.trimA, onlyJoins: s.onlyJoins, keepAvi: s.keepAvi,
      audio: s.audioOn,
      bloom: s.bloomOn ? s.bloom : 0, bloomAt: s.bloomAt,
      bloomAuto: s.bloomWhich === "auto", bloomSmooth: s.bloomSmooth,
      bloomCuts: state.bloomCuts.slice(),
      smearFrames: s.smearFrames, smearRepeat: s.smearRepeat,
      color: s.acidOn ? { sat: s.sat / 100, contrast: s.contrast / 100,
                          brightness: s.brightness / 100, hue_jump: s.hueJump,
                          style: s.acidStyle, spin: s.spin, objects: s.objectsOn,
                          clock: "colors", families: s.detail,
                          neon: s.neon, posterize: s.posterize } : null,
      bloomPoints: s.bloomOn && s.bloomWhich === "playhead" && state.bloomPoint
        ? [[state.bloomPoint.clip, state.bloomPoint.frame]] : null,
      outputDir: state.seqInfo && state.seqInfo.outputDir,
      mode: state.mode,
      timelineStarts: state.clips.map((c) => c.timelineStart),
    });
    if (state.mode === "manual") {
      body.keyframes = Array.from(state.picked).map((k) => k.split(":").map(Number));
    } else if (s.useRange && state.seqInfo && state.seqInfo.inOut) {
      body.range = state.seqInfo.inOut;
    }
    const { result, job } = await runHelperJob(body, "mosh");
    setStatus("Importing into Premiere…", "busy");
    setProgress(0.97);
    state.lastHadAudio = !!result.audio;
    const placed = await placeResult(result.output, result.seconds);
    setProgress(1, "ok");
    setStatus("Done", "ok");
    showResult(result, job, placed);
  });
}

function runTargeted() {
  return runBusy(async () => {
    const s = readSettings();
    const t = state.target;
    const body = {
      pick: t.pick, trail: s.trail, block: s.blockSize, refresh: s.bleed / 100, audio: s.audioOn,
      rendered: t.rendered, outputDir: state.seqInfo && state.seqInfo.outputDir,
      clips: [state.clips[t.clipIndex]],   // for the progress estimate
    };
    const { result, job } = await runHelperJob(body, "target");
    setStatus("Importing into Premiere…", "busy");
    setProgress(0.97);
    state.lastHadAudio = !!result.audio;
    const anchor = state.clips.findIndex((c) => clipKey(c) === t.clipKey);
    const placed = await placeResult(result.output, result.seconds, anchor === -1 ? 0 : anchor);
    setProgress(1, "ok");
    setStatus("Done", "ok");
    showResult(result, job, placed);
  });
}

async function onReveal() {
  if (!state.lastResultJob) return;
  try {
    const r = await fetch(HELPER + "/jobs/" + state.lastResultJob + "/reveal", { method: "POST" });
    if (!r.ok) logLine("Couldn't open the folder (is the helper still running?)", true);
  } catch (e) {
    logLine("Couldn't reach the helper to open the folder.", true);
  }
}

// ------------------------------------------------------------------ init

document.querySelector(".app").id = "app";
SLIDERS.forEach((id) => {
  $(id).addEventListener("input", () => { updateValueLabels(); saveSettings(); });
  $(id).addEventListener("change", () => { updateValueLabels(); saveSettings(); });
});
$("targetOn").addEventListener("change", () => { showTargetOpts(); saveSettings(); updateMoshButton(); });
$("btnPick").addEventListener("click", onPickObject);
$("btnPickUndo").addEventListener("click", () => state.target && state.target.pick &&
  pickCall({ undo: true }).catch((e) => logLine(String(e.message || e), true)));
$("btnPickClear").addEventListener("click", () => state.target && state.target.pick &&
  pickCall({ clear: true }).catch((e) => logLine(String(e.message || e), true)));
$("btnConfirm").addEventListener("click", onConfirm);
$("pickImg").addEventListener("click", onPickClick);
["onlyJoins", "useRange", "keepAvi", "audioOn"].forEach((id) => $(id).addEventListener("change", saveSettings));
$("bloomOn").addEventListener("change", () => { showBloomOpts(); saveSettings(); renderClips(state.lastWarnings); });
$("bloomSmooth").addEventListener("change", saveSettings);
$("acidOn").addEventListener("change", () => { showAcidOpts(); saveSettings(); });
$("stPrism").addEventListener("click", () => setAcidStyle("prism"));
$("objectsOn").addEventListener("change", () => { showDetail(); saveSettings(); });
$("stPure").addEventListener("click", () => setAcidStyle("pure"));
$("stTint").addEventListener("click", () => setAcidStyle("tint"));
$("neon").addEventListener("change", saveSettings);
$("btnAcidPreset").addEventListener("click", applyAcidPreset);
$("bwAuto").addEventListener("click", () => setBloomWhich("auto"));
$("bwAfter").addEventListener("click", () => setBloomWhich("after"));
$("bwPlayhead").addEventListener("click", () => setBloomWhich("playhead"));
$("btnUsePlayhead").addEventListener("click", onUsePlayhead);
document.querySelectorAll(".step").forEach((b) => {
  b.addEventListener("click", () => stepSlider(b.getAttribute("data-target"), Number(b.getAttribute("data-delta"))));
});
$("modeAuto").addEventListener("click", () => setMode("auto"));
$("modeManual").addEventListener("click", () => setMode("manual"));
$("srcTimeline").addEventListener("click", () => setSource("timeline"));
$("srcOriginal").addEventListener("click", () => setSource("original"));
$("btnScan").addEventListener("click", onScan);
$("pickAll").addEventListener("click", () => pickWhere(() => true));
$("pickCuts").addEventListener("click", () => pickWhere((k) => k.cut));
$("pickNone").addEventListener("click", () => pickWhere(() => false));
$("showMarkers").addEventListener("change", onShowMarkersChange);
$("btnMarkNow").addEventListener("click", onMarkNow);
$("btnStartHelper").addEventListener("click", onStartHelper);
$("btnClearMarkers").addEventListener("click", () => {
  $("showMarkers").checked = false;  // otherwise they'd be re-added on the next tick
  saveSettings();
  onClearMarkers();
});
$("btnReset").addEventListener("click", () => { applySettings(DEFAULTS); saveSettings(); });
$("btnRefresh").addEventListener("click", onUseSelection);
$("btnMosh").addEventListener("click", onMosh);
$("btnReveal").addEventListener("click", onReveal);
$("btnDetails").addEventListener("click", () => setDetailsOpen($("log").className.indexOf("hidden") !== -1));

loadSettings();
bindHelp();
bindNumberBoxes();
renderClips();
renderRangeInfo();
renderPicker();
setDetailsOpen(false);
checkHelper();
setInterval(checkHelper, 3000);
if (PREVIEW) logLine("Preview mode (not inside Premiere). Use selection loads the test clips.");
