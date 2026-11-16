/*
 * Windows 7 style sliders, checkboxes and number boxes.
 *
 * Premiere draws real <input>s its own way (thick black frames, sliders that don't
 * drag well) and ignores most CSS. So the real inputs stay hidden and keep holding the
 * values (main.js reads and writes them as before), and these drawn controls sit in
 * their place. A small timer keeps the drawn controls in step with the hidden inputs.
 */
(function () {
  const views = [];   // {sync()} for every drawn control

  function fire(input, type) {
    try { input.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) { /* ignore */ }
  }

  function setDisabled(el, on) {
    const has = el.className.indexOf("is-disabled") !== -1;
    if (on && !has) el.className += " is-disabled";
    if (!on && has) el.className = el.className.replace(/\s*is-disabled/g, "");
  }

  // ---------------------------------------------------------------- sliders
  function slider(input) {
    const box = document.createElement("div");
    box.className = "w7-slider";
    const track = document.createElement("div");
    track.className = "w7-track";
    const fill = document.createElement("div");
    fill.className = "w7-fill";
    const thumb = document.createElement("div");
    thumb.className = "w7-thumb";
    track.appendChild(fill);
    box.appendChild(track);
    box.appendChild(thumb);
    input.parentNode.insertBefore(box, input);
    input.style.display = "none";

    const min = () => Number(input.min), max = () => Number(input.max);
    const step = () => Number(input.step) || 1;
    let last = null;

    function sync() {
      const v = Number(input.value);
      const key = v + "|" + input.disabled + "|" + box.offsetWidth;
      if (key === last) return;
      last = key;
      const f = max() > min() ? (v - min()) / (max() - min()) : 0;
      const w = box.offsetWidth - 11;                   // thumb is 11px wide
      thumb.style.left = Math.round(Math.max(0, Math.min(1, f)) * Math.max(0, w)) + "px";
      fill.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + "%";
      setDisabled(box, input.disabled);
    }

    function setFromX(clientX) {
      const r = box.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left - 5.5) / Math.max(1, r.width - 11)));
      let v = min() + f * (max() - min());
      v = Math.round(v / step()) * step();
      v = Math.max(min(), Math.min(max(), v));
      if (String(v) !== String(input.value)) {
        input.value = String(v);
        sync();
        fire(input, "input");
      }
    }

    let dragging = false;
    function move(e) { if (dragging) { setFromX(e.clientX); e.preventDefault(); } }
    function up() {
      if (!dragging) return;
      dragging = false;
      box.className = box.className.replace(/\s*is-dragging/g, "");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      fire(input, "change");
    }
    box.addEventListener("mousedown", (e) => {
      if (input.disabled || e.button !== 0) return;
      dragging = true;
      box.className += " is-dragging";
      setFromX(e.clientX);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      e.preventDefault();
    });
    // mouse wheel: one step at a time
    box.addEventListener("wheel", (e) => {
      if (input.disabled) return;
      const v = Math.max(min(), Math.min(max(), Number(input.value) + (e.deltaY < 0 ? step() : -step())));
      if (String(v) !== String(input.value)) {
        input.value = String(v);
        sync();
        fire(input, "input");
        fire(input, "change");
      }
      e.preventDefault();
    });
    views.push({ sync });
    sync();
  }

  // ---------------------------------------------------------------- checkboxes
  function check(input) {
    if (input.getAttribute("data-w7")) return;
    input.setAttribute("data-w7", "1");
    const box = document.createElement("span");
    box.className = "w7-check";
    const mark = document.createElement("span");
    mark.className = "w7-mark";
    mark.textContent = "✔";
    box.appendChild(mark);
    input.parentNode.insertBefore(box, input);
    input.style.display = "none";
    let last = null;

    function sync() {
      const key = input.checked + "|" + input.disabled;
      if (key === last) return;
      last = key;
      box.className = "w7-check" + (input.checked ? " is-checked" : "") + (input.disabled ? " is-disabled" : "");
    }
    function toggle(e) {
      e.preventDefault();
      e.stopPropagation();
      if (input.disabled) return;
      input.checked = !input.checked;
      sync();
      fire(input, "change");
    }
    // clicking the label text toggles too (but not links/buttons inside the label)
    const label = input.closest ? input.closest("label") : null;
    if (label) {
      label.addEventListener("click", (e) => {
        const t = e.target;
        if (t !== label && t !== box && t !== mark && t.nodeType === 1 && t.closest && t.closest("[role=button], a, select")) return;
        toggle(e);
      });
    } else {
      box.addEventListener("click", toggle);
    }
    views.push({ sync, input });
    sync();
  }

  // ---------------------------------------------------------------- number boxes
  // Shown as a drawn Win7 text box; click it to type (the real field appears while typing).
  function number(input) {
    const view = document.createElement("div");
    view.className = "num-view";
    view.title = "Click to type a value";
    input.parentNode.insertBefore(view, input);
    input.style.display = "none";
    let editing = false;
    let last = null;

    function sync() {
      if (editing) return;
      const key = input.value + "|" + input.disabled;
      if (key === last) return;
      last = key;
      view.textContent = input.value;
      setDisabled(view, input.disabled);
    }
    function stop() {
      if (!editing) return;
      editing = false;
      input.style.display = "none";
      view.style.display = "";
      last = null;
      sync();
    }
    view.addEventListener("click", () => {
      if (input.disabled) return;
      editing = true;
      view.style.display = "none";
      input.style.display = "";
      input.focus();
      try { input.select(); } catch (e) { /* ignore */ }
    });
    input.addEventListener("blur", () => setTimeout(stop, 0));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") setTimeout(stop, 0);
    });
    views.push({ sync });
    sync();
  }

  function syncAll() {
    for (let i = views.length - 1; i >= 0; i--) {
      const v = views[i];
      // drop checkboxes that were removed (keyframe list is rebuilt often)
      if (v.input && !document.body.contains(v.input)) { views.splice(i, 1); continue; }
      v.sync();
    }
  }

  function init() {
    document.querySelectorAll('input[type="range"]').forEach(slider);
    document.querySelectorAll('input[type="checkbox"]').forEach(check);
    document.querySelectorAll("input.num").forEach(number);
    setInterval(syncAll, 120);
  }

  window.w7Check = check;     // for checkboxes made later (keyframe list)
  window.w7Sync = syncAll;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
