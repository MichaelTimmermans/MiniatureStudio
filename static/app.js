"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
};

async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || (data.errors && JSON.stringify(data.errors)) || res.statusText);
  }
  return data;
}

function say(msg, isError = false, target = "#message") {
  const box = $(target);
  box.textContent = msg;
  box.classList.toggle("error", isError);
}

async function guarded(fn, target) {
  try { await fn(); } catch (e) { say(e.message, true, target); }
}

const fmtBytes = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " kB";
const enc = encodeURIComponent;

let info = {};
let status = {};
let settings = {};

// ---------------------------------------------------------------- tabs
document.querySelectorAll("#tabs button").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== "tab-" + btn.dataset.tab; });
  const loaders = {
    controls: [loadControls], stacks: [loadStacks], gallery: [loadGallery], jobs: [loadJobs],
    settings: [loadSettings, loadStorage, loadDrive, loadNas],
    system: [loadSystem, loadLog],
  };
  (loaders[btn.dataset.tab] || []).forEach((fn) => fn().catch((e) => console.warn(e)));
}));

// ---------------------------------------------------------------- badges / status
function renderBadges() {
  const b = $("#badges");
  b.replaceChildren();
  if (info.camera_error) b.append(el("button", { class: "badge rec", title: info.camera_error,
    onclick: () => { document.querySelector('#tabs button[data-tab="controls"]').click(); $("#btn-camera-check").click(); } },
    "⚠ no camera — click to check"));
  else if (info.demo) b.append(el("span", { class: "badge warn" }, "DEMO (no camera)"));
  else if (info.model) b.append(el("span", { class: "badge" }, info.model));
  b.append(el("span", { class: "badge " + (info.focus_stack?.available ? "ok" : "warn"),
    title: info.focus_stack?.binary || "run ./install.sh" },
    info.focus_stack?.available ? `stacking: ${info.focus_stack.method} ✓` : "no stacker — run ./install.sh"));
  b.append(el("span", { class: "badge " + (info.drive ? "ok" : "") },
    info.drive ? (settings.upload?.auto_drive ? "Drive auto-upload" : "Drive ✓") : "No Drive"));
  if (info.nas) b.append(el("span", { class: "badge ok" }, "NAS ✓"));
  if (info.has_autofocus) b.append(el("span", { class: "badge" }, "AF"));
  if (status.recording?.active) b.append(el("span", { class: "badge rec" }, "● REC"));
  const writing = status.saving?.pending?.length || 0;
  const compressing = status.compressing?.queued || 0;
  if (writing || compressing) {
    b.append(el("span", { class: "badge", title: "Background work — you can keep shooting" },
      [writing ? `💾 writing ${writing}` : null, compressing ? `🗜 compressing ${compressing}` : null]
        .filter(Boolean).join(" · ")));
  }
  const st = status.storage;
  if (st?.target === "usb") {
    b.append(st.available
      ? el("span", { class: "badge ok", title: "Captures are saved to the USB disk" }, `USB ${st.label || "disk"}`)
      : el("span", { class: "badge warn", title: "Plug the disk back in, or switch to the SD card in Settings → Storage" }, "USB disk missing"));
  }
  // A camera that is detected but sends no frames (loose/damaged ribbon cable, "frontend timed out").
  if (status.preview_stalled_s > 8 && !status.recording?.active) {
    b.append(el("span", { class: "badge warn", title: "Shut down, reseat the ribbon cable at both ends (contacts the right way round, latch closed), check it is not pinched, or try another cable." },
      `⚠ camera sends no image (${Math.round(status.preview_stalled_s)} s) — check the ribbon cable`));
  }
  const err = status.saving?.last_error || status.compressing?.last_error;
  if (err) b.append(el("span", { class: "badge warn", title: err }, "save error"));
}

async function refreshStatus() {
  try { status = await api("/api/status"); } catch (_) { return; }
  const stack = status.stack;
  $("#btn-stack-start").disabled = !!stack || status.recording.active;
  $("#btn-stack-frame").disabled = !stack || !!stack.sweep;
  $("#btn-stack-end").disabled = !stack || !!stack.sweep;
  $("#btn-sweep-cancel").hidden = !(stack && stack.sweep);
  $("#btn-photo").disabled = status.recording.active;
  if (isBusy()) CAPTURE_BUTTONS.forEach((s) => { $(s).disabled = true; });  // a capture is running
  if (stack?.sweep) showBusy(`Lens sweep: frame ${stack.count}/${stack.total}…`, "sweep");
  else hideBusy("sweep");
  $("#stack-status").textContent = stack
    ? `Stack ${stack.name}: ${stack.count}${stack.total ? "/" + stack.total : ""} frames${stack.sweep ? " (sweep running)" : ""}`
    : "";
  const rec = status.recording;
  $("#btn-video").textContent = rec.active ? "⏹ Stop video" : "⏺ Start video";
  $("#video-timer").textContent = rec.active ? Math.round(Date.now() / 1000 - rec.started) + " s — " + rec.path : "";
  renderBadges();
}

// ---------------------------------------------------------------- capture
function label() { return $("#label").value.trim(); }

async function updateNameExample() {
  try {
    const r = await api("/api/settings/preview_name", "POST", { pattern: settings.filename_pattern || "", label: label() || "label" });
    $("#name-example").textContent = r.name;
  } catch (_) { /* ignore */ }
}
$("#label").addEventListener("input", updateNameExample);

function uploadNote(r) { return r.uploads && r.uploads.length ? " — will upload when saved" : ""; }

// Full-screen overlay while the camera is busy, so nothing gets clicked twice.
const busyReasons = new Set();
const CAPTURE_BUTTONS = ["#btn-photo", "#btn-stack-frame", "#btn-stack-start", "#btn-stack-end", "#btn-video"];
function showBusy(text, reason = "capture") {
  busyReasons.add(reason);
  $("#busy-text").textContent = text;
  $("#busy-overlay").hidden = false;
  CAPTURE_BUTTONS.forEach((s) => { $(s).dataset.busy = "1"; $(s).disabled = true; });
}
function hideBusy(reason = "capture") {
  busyReasons.delete(reason);
  if (busyReasons.size) return;
  $("#busy-overlay").hidden = true;
  CAPTURE_BUTTONS.forEach((s) => { delete $(s).dataset.busy; });
  refreshStatus();  // restores the right enabled/disabled state
}
const isBusy = () => busyReasons.size > 0;

$("#btn-photo").addEventListener("click", () => guarded(async () => {
  if (isBusy()) return;
  showBusy("Capturing photo…");
  try {
    const r = await api("/api/capture", "POST", { label: label() });
    say(`Captured ${r.file} in ${r.seconds}s — saving in the background${uploadNote(r)}`);
  } finally { hideBusy(); refreshStatus(); }
}));

// One "Start stack": manual (frame by frame) or, on autofocus cameras, a lens sweep.
function stackMode() {
  return info.has_autofocus && document.querySelector('input[name="stack-mode"]:checked')?.value === "sweep"
    ? "sweep" : "manual";
}
function showStackMode() {
  const sweep = stackMode() === "sweep";
  $("#sweep-box").hidden = !sweep;
  document.querySelectorAll(".manual-only").forEach((e) => { e.hidden = sweep; });
  $("#stack-autoprocess-label").hidden = sweep || !!info.has_autofocus;  // AF: always auto-stacked
  $("#stack-mode-hint").textContent = sweep
    ? "The app steps the lens from start to end, takes a frame at each position and stacks them."
    : (info.has_autofocus
      ? "Start, then for each frame set the focus (LensPosition in the Camera tab) and press + Frame. Finish when done."
      : "Start, then for each frame turn the focus ring a little and press + Frame. Finish when done.");
}
document.querySelectorAll('input[name="stack-mode"]').forEach((r) => r.addEventListener("change", () => {
  store("stackMode", stackMode());
  showStackMode();
}));

$("#btn-stack-start").addEventListener("click", () => guarded(async () => {
  if (stackMode() === "sweep") {
    const s = await api("/api/stack/sweep", "POST", sweepBody());
    say(`Sweep ${s.name} started`);
    watchJob(s.job);
    refreshStatus();
    return;
  }
  const r = await api("/api/stack/start", "POST", { label: label() });
  say(`Stack ${r.name} started — set focus and take frames` + (r.exposure_locked ? " (exposure & white balance locked)" : ""));
  refreshStatus();
}));

let frameBusy = false;
async function stackFrame() {
  if (frameBusy || isBusy()) return;
  frameBusy = true;
  showBusy(`Capturing frame ${(status.stack?.count || 0) + 1}…`);
  try {
    const r = await api("/api/stack/frame", "POST", {});
    say(`Frame ${r.frame} captured in ${r.seconds}s — adjust focus for the next one`);
  } catch (e) { say(e.message, true); }
  finally { frameBusy = false; hideBusy(); refreshStatus(); }
}
$("#btn-stack-frame").addEventListener("click", stackFrame);

$("#btn-stack-end").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/stack/end", "POST", { process: $("#stack-autoprocess").checked });
  say(`Stack ${r.name} finished (${r.frames} frames)` + (r.job ? " — processing started" : "") + uploadNote(r));
  if (r.job) watchJob(r.job);
  refreshStatus();
}));

$("#btn-video").addEventListener("click", () => guarded(async () => {
  if (status.recording?.active) {
    const r = await api("/api/video/stop", "POST", {});
    say(`Video saved: ${r.file} (${r.seconds}s)${uploadNote(r)}`);
  } else {
    const r = await api("/api/video/start", "POST", { label: label() });
    say(`Recording started: ${r.file}`);
  }
  refreshStatus();
}));

// sweep
function sweepBody() {
  return {
    label: label(),
    start: parseFloat($("#sweep-start").value),
    end: parseFloat($("#sweep-end").value),
    steps: parseInt($("#sweep-steps").value, 10),
    settle_ms: parseInt($("#sweep-settle").value, 10),
  };
}
$("#btn-sweep-cancel").addEventListener("click", () => guarded(async () => {
  if (status.stack?.job) await api(`/api/jobs/${status.stack.job}/cancel`, "POST", {});
}));
let lensNow = null;
$("#btn-sweep-from").addEventListener("click", () => { if (lensNow !== null) $("#sweep-start").value = lensNow.toFixed(2); });
$("#btn-sweep-to").addEventListener("click", () => { if (lensNow !== null) $("#sweep-end").value = lensNow.toFixed(2); });

async function pollLens() {
  if (!info.has_autofocus || document.hidden) return;
  try {
    const r = await api("/api/controls");
    const lp = r.live.LensPosition ?? r.controls.find((c) => c.name === "LensPosition")?.value;
    if (typeof lp === "number") { lensNow = lp; $("#lens-now").textContent = lp.toFixed(2); }
  } catch (_) { /* ignore */ }
}

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.code === "Space" && status.stack && !status.stack.sweep) { e.preventDefault(); stackFrame(); }
  else if (e.key === "p" || e.key === "P") { e.preventDefault(); $("#btn-photo").click(); }
});

// jobs
const watched = new Set();
function watchJob(id) {
  if (watched.has(id)) return;
  watched.add(id);
  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${id}`); } catch (_) { watched.delete(id); return; }
    if (job.status === "queued" || job.status === "running") {
      $("#stack-status").dataset.job = `${job.kind} ${job.name}: ${job.log.at(-1) || job.status}`;
      setTimeout(tick, 1500);
      return;
    }
    watched.delete(id);
    if (job.status === "done") {
      say(`${job.kind} ${job.name} done` + (job.result?.output ? ` → ${job.result.output}` : ""));
      if (job.result?.process_job) watchJob(job.result.process_job);
    } else {
      say(`${job.kind} ${job.name} failed: ${job.error}`, true);
    }
    refreshStatus();
    if (!$("#tab-stacks").hidden) loadStacks();
  };
  tick();
}

async function loadJobs() {
  const r = await api("/api/jobs");
  const box = $("#jobs");
  box.replaceChildren();
  if (!r.jobs.length) box.append(el("p", { class: "muted" }, "No jobs yet."));
  for (const j of r.jobs) {
    box.append(el("div", { class: "card" },
      el("div", { class: "row" },
        el("strong", {}, `${j.kind}`), el("span", {}, j.name),
        el("span", { class: "badge " + ({ done: "ok", error: "warn", running: "", queued: "" })[j.status] }, j.status),
        (j.status === "running" || j.status === "queued") && j.kind !== "upload"
          ? el("button", { onclick: () => api(`/api/jobs/${j.id}/cancel`, "POST", {}).then(loadJobs) }, "Cancel") : null,
        el("button", { onclick: async () => {
          const full = await api(`/api/jobs/${j.id}`);
          box.querySelector(`pre[data-id="${j.id}"]`).textContent = full.log.join("\n");
        } }, "Log"),
        j.status === "done" || j.status === "error"
          ? el("button", { class: "danger", title: "Remove this job from the list",
              onclick: () => api(`/api/jobs/${j.id}`, "DELETE").then(loadJobs).catch((e) => alert(e.message)) }, "Delete")
          : null),
      j.error ? el("div", { class: "error small" }, j.error) : null,
      el("pre", { "data-id": j.id, class: "log" }, j.log.join("\n"))));
  }
}

// ---------------------------------------------------------------- preview: grid, focus check
$("#toggle-grid").addEventListener("change", (e) => { $("#grid-overlay").hidden = !e.target.checked; });

let focusPoint = { x: 0.5, y: 0.5 };
let focusTimer = null;
let sharpMax = 0;
function setFocusPoint(e) {
  const r = $("#preview").getBoundingClientRect();
  focusPoint = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                 y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  const m = $("#focus-marker");
  m.style.left = focusPoint.x * 100 + "%";
  m.style.top = focusPoint.y * 100 + "%";
  sharpMax = 0;
}
$("#preview").addEventListener("click", setFocusPoint);
$("#toggle-focus").addEventListener("change", (e) => {
  const on = e.target.checked;
  $("#focus-check").hidden = !on;
  $("#focus-marker").hidden = !on;
  clearTimeout(focusTimer);
  sharpMax = 0;
  if (on) focusLoop();
  else api("/api/focus_check/stop", "POST", {}).catch(() => {});  // back to the fast preview
});
async function focusLoop() {
  if (!$("#toggle-focus").checked) return;
  try {
    const res = await fetch(`/api/focus_check?x=${focusPoint.x}&y=${focusPoint.y}&size=800`);
    if (res.ok) {
      const score = parseFloat(res.headers.get("X-Sharpness"));
      sharpMax = Math.max(sharpMax, score);
      $("#sharpness").textContent = score.toFixed(0);
      $("#sharpness-max").textContent = sharpMax.toFixed(0);
      const img = $("#focus-crop");
      const old = img.src;
      img.src = URL.createObjectURL(await res.blob());
      if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    }
  } catch (_) { /* ignore */ }
  // One crop per second: back-to-back requests keep the full-res buffers busy and
  // degrade the live preview (a clear preview matters more). Slower in a hidden tab.
  focusTimer = setTimeout(focusLoop, document.hidden ? 2000 : 1000);
}

// ---------------------------------------------------------------- controls
let controlsDesc = [];
const pending = {};
let pendingTimer = null;
function queueControl(name, value) {
  pending[name] = value;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    const body = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    try {
      const r = await api("/api/controls", "POST", body);
      $("#live").classList.remove("error");
      if (r.switched && r.switched.length) {
        $("#live").textContent = `Switched to manual: ${r.switched.join(", ")}`;
        loadControls().catch(() => {});
      }
    }
    catch (e) { $("#live").textContent = e.message; $("#live").classList.add("error"); }
  }, 250);
}

function numberInput(c, value, onChange, idx) {
  const isFloat = c.type === "float" || c.numeric === "float";
  const min = c.min, max = c.max;
  // Very wide ranges (ExposureTime in µs) get a log slider so small values stay usable.
  const logScale = typeof min === "number" && min >= 0 && max / Math.max(min, 1) > 1000;
  const toSlider = (v) => logScale ? Math.log10(Math.max(v, Math.max(min, 1))) : v;
  const fromSlider = (s) => logScale ? Math.pow(10, s) : s;
  const range = el("input", { type: "range",
    min: toSlider(Math.max(min, logScale ? 1 : min)), max: toSlider(max),
    step: logScale ? 0.001 : (isFloat ? (max - min) / 1000 : 1) });
  const num = el("input", { type: "number", step: isFloat ? "any" : 1, min, max, class: "num",
    inputmode: isFloat ? "decimal" : "numeric" });
  const set = (v) => { if (v === null || v === undefined) return; num.value = isFloat ? +(+v).toFixed(4) : Math.round(v); range.value = toSlider(+v); };
  set(value);
  range.addEventListener("input", () => {
    const v = fromSlider(parseFloat(range.value));
    num.value = isFloat ? +v.toFixed(4) : Math.round(v);
    onChange(isFloat ? v : Math.round(v), idx);
  });
  num.addEventListener("change", () => { set(parseFloat(num.value)); onChange(parseFloat(num.value), idx); });
  // − / + fine-tune buttons (precise on touch screens): relative steps on log ranges
  // (ExposureTime), otherwise 1/200 of the range, or 1 for whole numbers. Hold to repeat.
  const nudge = (dir) => {
    let v = parseFloat(num.value);
    if (isNaN(v)) v = Math.max(min, logScale ? 1 : min);
    if (logScale) v = dir > 0 ? Math.max(v * 1.05, v + 1) : Math.min(v / 1.05, v - 1);
    else v += dir * (isFloat ? niceStep((max - min) / 200) : Math.max(1, Math.round((max - min) / 200)));
    v = Math.min(max, Math.max(min, v));
    if (!isFloat) v = Math.round(v); else v = +v.toFixed(4);
    set(v);
    onChange(v, idx);
  };
  const stepButton = (dir, text) => {
    const b = el("button", { class: "step", type: "button", title: dir > 0 ? "Increase (hold to repeat)" : "Decrease (hold to repeat)" }, text);
    let timer = null, delay = 400;
    const stop = () => { clearTimeout(timer); timer = null; delay = 400; };
    const repeat = () => { nudge(dir); delay = Math.max(60, delay * 0.8); timer = setTimeout(repeat, delay); };
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) { /* not all pointers can be captured */ }
      repeat();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => b.addEventListener(ev, stop));
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nudge(dir); } });
    return b;
  };
  return el("span", { class: "numctl" }, stepButton(-1, "−"), range, stepButton(1, "+"), num);
}

// 0.0137 -> 0.01, 0.37 -> 0.5: round a step to 1, 2 or 5 times a power of ten.
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function controlRow(c) {
  let input;
  if (c.type === "enum") {
    input = el("select", { onchange: (e) => queueControl(c.name, parseInt(e.target.value, 10)) },
      c.options.map((o) => el("option", { value: o.value, selected: o.value === c.value }, `${o.label} (${o.value})`)));
  } else if (c.type === "bool") {
    input = el("input", { type: "checkbox", checked: !!c.value, onchange: (e) => queueControl(c.name, e.target.checked) });
  } else if (c.type === "array") {
    const values = Array.isArray(c.value) ? [...c.value] : Array(c.length).fill(c.min);
    input = el("div", { class: "array" }, values.map((v, i) =>
      numberInput(c, v, (nv, idx) => { values[idx] = nv; queueControl(c.name, values); }, i)));
  } else if (c.type === "int" || c.type === "float") {
    input = numberInput(c, c.value ?? c.default ?? c.min, (v) => queueControl(c.name, v));
  } else {
    input = el("input", { value: JSON.stringify(c.value), class: "json",
      onchange: (e) => queueControl(c.name, e.target.value) });
  }
  const reset = el("button", { class: "tiny", title: `default: ${JSON.stringify(c.default)}`,
    onclick: () => { if (c.default !== null) { queueControl(c.name, c.default); setTimeout(loadControls, 600); } } }, "↺");
  const pinned = pinnedControls().includes(c.name);
  const pin = el("button", { class: "pin" + (pinned ? " on" : ""), title: pinned ? "Remove from Most used" : "Add to Most used",
    onclick: () => togglePin(c.name) }, pinned ? "★" : "☆");
  const unit = CONTROL_UNITS[c.name];
  return el("div", { class: "control", "data-name": c.name.toLowerCase() },
    el("label", { title: `${JSON.stringify(c.min)} … ${JSON.stringify(c.max)}` }, unit ? `${c.name} (${unit})` : c.name, infoIcon(c.name)),
    input, reset, pin);
}

// Controls you tweak all the time; the user can change the list with the ☆ pins.
const DEFAULT_PINNED = ["AeEnable", "ExposureTimeMode", "ExposureTime", "AnalogueGainMode", "AnalogueGain",
  "ExposureValue", "AwbEnable", "AwbMode", "ColourTemperature", "Brightness", "Contrast", "Saturation",
  "Sharpness", "AfMode", "LensPosition"];
const CONTROL_UNITS = { ExposureTime: "µs", ColourTemperature: "K", LensPosition: "dioptre", FrameDurationLimits: "µs" };
function pinnedControls() { return settings.ui?.pinned_controls || DEFAULT_PINNED; }
async function togglePin(name) {
  const list = pinnedControls().filter((n) => n !== name);
  if (list.length === pinnedControls().length) list.push(name);
  await api("/api/settings", "POST", { ui: { pinned_controls: list } });
  settings.ui = { ...(settings.ui || {}), pinned_controls: list };
  renderControls();
}

let cameraState = {};
async function loadCameras() {
  cameraState = await api("/api/cameras");
  const r = cameraState;
  $("#camera-select").replaceChildren(...r.cameras.map((c) =>
    el("option", { value: c.index, selected: c.index === r.active },
      `${c.index}: ${c.model}${c.usb ? " (USB)" : c.location !== null && c.location !== undefined ? ` (port ${c.location})` : ""}`
      + (c.index === r.default ? " ★ default" : ""))));
  $("#btn-camera-default").disabled = r.active === r.default;
  // Capture resolution: the sensor's modes (Pi cameras); full resolution by default.
  const modes = info.sensor_modes || [];
  $("#resolution-row").hidden = !modes.length;
  const current = JSON.stringify(info.still_size || null);
  $("#still-size").replaceChildren(el("option", { value: "null" }, "Full sensor resolution"),
    ...modes.map((m) => el("option", { value: JSON.stringify(m.size), selected: JSON.stringify(m.size) === current },
      `${m.size[0]}×${m.size[1]} (${(m.size[0] * m.size[1] / 1e6).toFixed(1)} MP)`)));
  try {
    const s = await api("/api/camera/sensor");
    const [overlay, port] = (s.overlays[0] || "auto").split(",");
    $("#sensor-select").value = overlay; $("#sensor-port").value = port || "";
    $("#sensor-info").dataset.config = s.config;
  } catch (_) { $("#btn-sensor-apply").disabled = true; }
}
$("#still-size").addEventListener("change", (e) => guarded(async () => {
  await api("/api/settings", "POST", { camera: { still_size: JSON.parse(e.target.value) } });
  info = await api("/api/camera_info");
  $("#live").textContent = "Capture resolution saved — used from the next capture.";
}, "#live"));
$("#btn-camera-rescan").addEventListener("click", () => guarded(async () => {
  if (!confirm("Restart the app to look for newly connected cameras?")) return;
  $("#live").textContent = "Restarting to rescan cameras…";
  await api("/api/system/restart", "POST", {});
  const back = async () => { try { await api("/api/version"); location.reload(); } catch (_) { setTimeout(back, 2000); } };
  setTimeout(back, 4000);
}, "#live"));
$("#btn-goto-camera-type").addEventListener("click", () => {
  const box = $("#camera-type-box");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  box.classList.add("flash");
  setTimeout(() => box.classList.remove("flash"), 2000);
});
$("#btn-notice-check").addEventListener("click", () => {
  $("#camera-type-box").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#btn-camera-check").click();
});
$("#btn-camera-check").addEventListener("click", () => guarded(async () => {
  const btn = $("#btn-camera-check");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const r = await api("/api/camera/diagnostics");
    $("#camera-check").hidden = false;
    $("#camera-check-verdict").textContent = r.autofocus ? `${r.verdict}\n\nAutofocus: ${r.autofocus}` : r.verdict;
    $("#camera-check-list").textContent = r.list_cameras;
    $("#camera-check-config").textContent = r.config.path
      ? `${r.config.path}\n${r.config.lines.join("\n") || "(no camera lines — automatic detection)"}`
      : "config.txt not found";
    $("#camera-check-kernel").textContent = r.kernel.join("\n");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run camera check";
  }
}, "#live"));
$("#btn-sensor-apply").addEventListener("click", () => guarded(async () => {
  const sensor = $("#sensor-select").value, port = $("#sensor-port").value;
  const label = $("#sensor-select").selectedOptions[0].textContent;
  if (!confirm(`Set the camera sensor to “${label}” and reboot the Pi?

config.txt is changed (a backup is kept).`)) return;
  await api("/api/camera/sensor", "POST", { sensor, port });
  await api("/api/system/reboot", "POST", {});
  $("#live").textContent = "Rebooting with the new camera setting — the page reloads when the Pi is back…";
  const back = async () => { try { await api("/api/version"); location.reload(); } catch (_) { setTimeout(back, 3000); } };
  setTimeout(back, 30000);
}, "#live"));
$("#camera-select").addEventListener("change", (e) => guarded(async () => {
  $("#live").textContent = "Switching camera…";
  await api("/api/cameras", "POST", { index: parseInt(e.target.value, 10) });
  location.reload();  // AF/sweep/controls all depend on the camera
}, "#live"));
$("#btn-camera-default").addEventListener("click", () => guarded(async () => {
  await api("/api/cameras/default", "POST", { index: cameraState.active });
  loadCameras();
}, "#live"));

// presets: named control sets per camera model; one can be loaded at boot
let presetState = {};
async function loadPresets() {
  presetState = await api("/api/presets");
  const r = presetState;
  $("#preset-model").textContent = r.model;
  const sel = $("#preset-select");
  const previous = sel.value;
  sel.replaceChildren(...(r.presets.length
    ? r.presets.map((n) => el("option", { value: n, selected: n === previous || (!previous && n === r.default) },
        n + (n === r.default ? " ★ boot" : "")))
    : [el("option", { value: "" }, "(no presets yet)")]));
  const none = !r.presets.length;
  ["#btn-preset-load", "#btn-preset-delete", "#btn-preset-default"].forEach((b) => { $(b).disabled = none; });
  $("#btn-preset-default").textContent = sel.value && sel.value === r.default ? "Don't load at boot" : "Load at boot";
  $("#preset-info").textContent = r.default
    ? `"${r.default}" is loaded at every boot.`
    : "No boot preset — the last used controls are restored at boot.";
}
$("#preset-select").addEventListener("change", () => {
  $("#btn-preset-default").textContent = $("#preset-select").value === presetState.default ? "Don't load at boot" : "Load at boot";
});
$("#btn-preset-load").addEventListener("click", () => guarded(async () => {
  await api(`/api/presets/${enc($("#preset-select").value)}/load`, "POST", {});
  await loadControls();
  $("#live").textContent = `Preset "${$("#preset-select").value}" loaded`;
}, "#live"));
$("#btn-preset-save").addEventListener("click", () => guarded(async () => {
  const name = prompt("Preset name (saves the current camera controls):", $("#preset-select").value || "");
  if (!name) return;
  if (presetState.presets.includes(name) && !confirm(`Overwrite preset "${name}"?`)) return;
  const r = await api("/api/presets", "POST", { name });
  await loadPresets();
  $("#preset-select").value = r.name;
  $("#live").textContent = `Preset "${r.name}" saved`;
}, "#live"));
$("#btn-preset-delete").addEventListener("click", () => guarded(async () => {
  const name = $("#preset-select").value;
  if (!confirm(`Delete preset "${name}"?`)) return;
  await api(`/api/presets/${enc(name)}`, "DELETE");
  $("#preset-select").value = "";
  loadPresets();
}, "#live"));
$("#btn-preset-default").addEventListener("click", () => guarded(async () => {
  const name = $("#preset-select").value;
  await api("/api/presets/default", "POST", { name: name === presetState.default ? null : name });
  loadPresets();
}, "#live"));

async function loadControls() {
  loadCameras().catch(() => {});
  loadPresets().catch(() => {});
  const r = await api("/api/controls");
  controlsDesc = r.controls;
  renderControls();
  renderLive(r.live);
}
function renderControls() {
  const pinned = pinnedControls();
  const byName = Object.fromEntries(controlsDesc.map((c) => [c.name, c]));
  $("#quick-controls").replaceChildren(...pinned.filter((n) => byName[n]).map((n) => controlRow(byName[n])));
  $("#controls").replaceChildren(...controlsDesc.filter((c) => !pinned.includes(c.name)).map(controlRow));
  applyFilter();
}
function renderLive(live) {
  $("#live").classList.remove("error");
  $("#live").textContent = Object.entries(live).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? v.map((x) => +(+x).toFixed(3)).join("/") : typeof v === "number" ? +v.toFixed(3) : v}`).join("  ·  ");
}
function applyFilter() {
  const q = $("#control-filter").value.toLowerCase();
  document.querySelectorAll("#controls .control").forEach((row) => { row.hidden = q && !row.dataset.name.includes(q); });
}
$("#control-filter").addEventListener("input", applyFilter);
$("#btn-controls-reset").addEventListener("click", () => guarded(async () => {
  if (!confirm("Reset all camera controls to their defaults?")) return;
  await api("/api/controls", "POST", { reset: true });
  loadControls();
}, "#live"));
$("#btn-af").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/autofocus/trigger", "POST", {});
  $("#live").textContent = `Autofocus ${r.ok ? "succeeded" : "failed"} — LensPosition ${r.lens_position}`;
}, "#live"));
setInterval(async () => {
  if ($("#tab-controls").hidden || document.hidden) return;
  try { renderLive((await api("/api/controls")).live); } catch (_) { /* ignore */ }
}, 2000);

// ---------------------------------------------------------------- histogram & clipping (computed in the browser)
const HIST_W = 320, HIST_H = 240;
const sampler = Object.assign(document.createElement("canvas"), { width: HIST_W, height: HIST_H });
const samplerCtx = sampler.getContext("2d", { willReadFrequently: true });
let histTimer = null;

function histogramLoop() {
  clearTimeout(histTimer);
  const wantHist = $("#toggle-histogram").checked, wantClip = $("#toggle-clipping").checked;
  if (!wantHist && !wantClip) return;
  const img = $("#preview");
  if (img.naturalWidth && !document.hidden) {
    try {
      samplerCtx.drawImage(img, 0, 0, HIST_W, HIST_H);
      const px = samplerCtx.getImageData(0, 0, HIST_W, HIST_H).data;
      const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      let high = 0, low = 0;
      const clip = wantClip ? samplerCtx.createImageData(HIST_W, HIST_H) : null;
      const cr = crop.enabled ? cropRect() : null;  // histogram of the cropped area only
      const [cx0, cy0, cx1, cy1] = cr ? [cr.x * HIST_W, cr.y * HIST_H, (cr.x + cr.w) * HIST_W, (cr.y + cr.h) * HIST_H]
                                      : [0, 0, HIST_W, HIST_H];
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const px_i = i >> 2, x = px_i % HIST_W, y = (px_i / HIST_W) | 0;
        if (x < cx0 || x >= cx1 || y < cy0 || y >= cy1) continue;
        n++;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const l = (r * 54 + g * 183 + b * 19) >> 8;  // Rec.709 luma
        bins[0][r]++; bins[1][g]++; bins[2][b]++; bins[3][l]++;
        if (r >= 254 || g >= 254 || b >= 254) {
          high++;
          if (clip) { clip.data[i] = 255; clip.data[i + 3] = 200; }  // red where a channel blows out
        } else if (l <= 2) low++;
      }
      n = Math.max(n, 1);
      if (wantHist) drawHistogram(bins, high / n, low / n);
      if (clip) {
        const ov = $("#clip-overlay");
        ov.width = HIST_W; ov.height = HIST_H;
        ov.getContext("2d").putImageData(clip, 0, 0);
      }
    } catch (_) { /* frame not decodable yet */ }
  }
  histTimer = setTimeout(histogramLoop, 700);
}

function drawHistogram(bins, highFrac, lowFrac) {
  const c = $("#histogram"), ctx = c.getContext("2d"), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  // sqrt scale: the huge black-background peak would otherwise flatten everything else
  const peak = Math.sqrt(Math.max(...bins.slice(0, 3).map((b) => Math.max(...b.slice(1, 255))), 1));
  const colours = ["rgba(255,70,70,.55)", "rgba(70,220,90,.55)", "rgba(80,140,255,.55)"];
  ctx.globalCompositeOperation = "lighter";
  bins.slice(0, 3).forEach((b, ch) => {
    ctx.fillStyle = colours[ch];
    for (let v = 0; v < 256; v++) {
      const bh = Math.min(h, (Math.sqrt(b[v]) / peak) * h);
      ctx.fillRect(v * (w / 256), h - bh, w / 256 + 0.5, bh);
    }
  });
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = "rgba(255,255,255,.8)";
  ctx.beginPath();
  for (let v = 0; v < 256; v++) {
    const y = h - Math.min(h, (Math.sqrt(bins[3][v]) / peak) * h);
    v ? ctx.lineTo(v * (w / 256), y) : ctx.moveTo(0, y);
  }
  ctx.stroke();
  const pct = (f) => (f * 100).toFixed(f < 0.01 ? 2 : 1) + "%";
  const info = $("#histogram-info");
  info.textContent = `Blown highlights: ${pct(highFrac)} · pure black: ${pct(lowFrac)}`;
  info.className = "small " + (highFrac > 0.005 ? "error" : "muted");
  if (highFrac > 0.005) info.textContent += " — lower ExposureTime or AnalogueGain";
}

["#toggle-histogram", "#toggle-clipping"].forEach((id) => $(id).addEventListener("change", () => {
  $("#histogram-box").hidden = !$("#toggle-histogram").checked;
  $("#clip-overlay").hidden = !$("#toggle-clipping").checked;
  histogramLoop();
}));

$("#btn-lock-exposure").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/controls/lock_exposure", "POST", {});
  await loadControls();
  $("#live").textContent = Object.keys(r.locked).length
    ? "Exposure and white balance locked: " + Object.entries(r.locked).map(([k, v]) => `${k}=${Array.isArray(v) ? v.map((x) => +(+x).toFixed(3)).join("/") : +(+v).toFixed(3)}`).join(", ")
    : "Already manual — nothing to lock.";
}, "#live"));

// ---------------------------------------------------------------- system: Pi stats & power
const mb = (n) => n >= 1024 ? (n / 1024).toFixed(1) + " GB" : n + " MB";
function uptimeText(s) {
  if (s == null) return "–";
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? `${d}d ` : "") + `${h}h ${m}m`;
}
function meter(used, total, text, warnAt = 0.75, critAt = 0.9) {
  const f = total ? used / total : 0;
  return el("div", {}, text, el("div", { class: "bar" + (f >= critAt ? " crit" : f >= warnAt ? " warn" : "") },
    el("span", { style: `width:${Math.min(100, f * 100).toFixed(1)}%` })));
}
let systemTimer = null;
async function loadSystem() {
  clearTimeout(systemTimer);
  const s = await api("/api/system");
  const warn = $("#system-warnings");
  warn.replaceChildren();
  if (s.throttle?.now.length) {
    warn.append(el("div", { class: "alert" }, `Right now: ${s.throttle.now.join(", ")}. ` +
      (s.throttle.now.includes("under-voltage") ? "The power supply is too weak — use the official 5.1 V / 2.5 A (Pi 3B) supply and a short cable." : "The Pi is too hot — improve cooling.")));
  } else if (s.throttle?.since_boot.length) {
    warn.append(el("div", { class: "alert past" }, `Since boot: ${s.throttle.since_boot.join(", ")} happened at some point.` +
      (s.throttle.since_boot.includes("under-voltage") ? " Check the power supply." : "")));
  }
  const m = s.memory, c = s.cpu;
  const memUsed = m.total_mb - m.available_mb, swapUsed = m.swap_total_mb - m.swap_free_mb;
  const rows = [
    ["Model", s.model], ["OS", s.os], ["Kernel", s.kernel], ["Hostname", `${s.hostname} (${s.ips.join(", ") || "no IP"})`],
    ["Uptime", uptimeText(s.uptime_s)],
    ["CPU", `${c.cores} cores${c.freq_mhz ? ` @ ${c.freq_mhz} MHz` : ""} — ${c.usage ?? "…"}% busy` + (c.load ? `, load ${c.load.join(" / ")}` : "")],
    ["Temperature", c.temp_c != null ? meter(c.temp_c, 85, `${c.temp_c} °C`, 0.8, 0.94) : "–"],
    ["Memory", meter(memUsed, m.total_mb, `${mb(memUsed)} used of ${mb(m.total_mb)}`)],
    ["Swap", m.swap_total_mb ? meter(swapUsed, m.swap_total_mb, `${mb(swapUsed)} used of ${mb(m.swap_total_mb)}`)
      : el("span", { class: "error" }, "none — focus stacking may run out of memory")],
  ];
  for (const [name, d] of Object.entries(s.disks)) {
    if (d) rows.push([name === "sd" ? "SD card" : "USB disk",
      meter(d.total - d.free, d.total, `${gb(d.free)} free of ${gb(d.total)}`, 0.85, 0.95)]);
  }
  rows.push(["App", `${s.app.version} — camera ${s.app.camera}${s.app.demo ? " (demo)" : ""}, stacking: ${s.app.stacker || "none"}`],
            ["Python", s.python]);
  $("#system-stats").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "–")]));
  if (!$("#tab-system").hidden) systemTimer = setTimeout(() => loadSystem().catch(() => {}), 3000);
}

async function power(action, question, after) {
  if (!confirm(question)) return;
  const r = await api(`/api/system/${action}`, "POST", {});
  say(after + (r.interrupted_jobs.length ? ` (interrupted: ${r.interrupted_jobs.join(", ")})` : ""), false, "#system-message");
  if (action !== "shutdown") {
    const back = async () => { try { await api("/api/version"); location.reload(); } catch (_) { setTimeout(back, 3000); } };
    setTimeout(back, action === "reboot" ? 30000 : 4000);
  }
}
$("#btn-restart-app").addEventListener("click", () => guarded(() =>
  power("restart", "Restart the MiniatureStudio app?", "Restarting the app…"), "#system-message"));
$("#btn-reboot").addEventListener("click", () => guarded(() =>
  power("reboot", "Reboot the Raspberry Pi? This takes about a minute.", "Rebooting — the page reloads when the Pi is back…"), "#system-message"));
$("#btn-shutdown").addEventListener("click", () => guarded(() =>
  power("shutdown", "Shut down the Raspberry Pi? You need to unplug and replug the power to start it again.",
        "Shutting down — wait until the green LED stops blinking before unplugging."), "#system-message"));

// ---------------------------------------------------------------- system: log window
let logTimer = null;
async function loadLog() {
  clearTimeout(logTimer);
  const lines = $("#log-lines").value, req = $("#log-requests").checked ? 1 : 0;
  const r = await api(`/api/system/log?lines=${lines}&requests=${req}`);
  const q = $("#log-filter").value.toLowerCase();
  const view = $("#log-view");
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 20;
  view.replaceChildren(...r.lines.filter((l) => !q || l.toLowerCase().includes(q)).map((l) => {
    const cls = /\b(ERROR|CRITICAL|Traceback)\b/.test(l) ? "lvl-error" : /\bWARN(ING)?\b/.test(l) ? "lvl-warn" : null;
    return el("div", { class: cls }, l);
  }));
  if (atBottom) view.scrollTop = view.scrollHeight;  // follow new lines unless you scrolled up
  $("#log-source").textContent = r.source === "journal"
    ? "Source: systemd journal (includes camera/libcamera messages)."
    : "Source: app memory (the systemd journal is not readable for this user; camera driver messages are missing).";
  if ($("#log-auto").checked && !$("#tab-system").hidden) logTimer = setTimeout(() => loadLog().catch(() => {}), 4000);
}
["#log-lines", "#log-requests", "#log-auto"].forEach((id) => $(id).addEventListener("change", () => loadLog().catch(() => {})));
$("#log-filter").addEventListener("input", () => loadLog().catch(() => {}));
$("#btn-log-refresh").addEventListener("click", () => loadLog().catch((e) => { $("#log-source").textContent = e.message; }));

// ---------------------------------------------------------------- crop (stored on the Pi, applied to captures)
// Normalised to the full frame: center (cx, cy), size (0.3-1) and an aspect ratio.
let crop = { enabled: false, aspect: "3:4", size: 1, cx: 0.5, cy: 0.5 };
function frameAspect() {
  const s = info.still_size || info.sensor_resolution || [4, 3];
  return s[0] / s[1];
}
function sanitizeCrop() {
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null ? Math.min(hi, Math.max(lo, +v)) : d);
  crop.cx = num(crop.cx, 0.5, 0, 1);
  crop.cy = num(crop.cy, 0.5, 0, 1);
  crop.size = num(crop.size, 1, 0.3, 1);
  if (!/^\d+:\d+$/.test(crop.aspect || "")) crop.aspect = "3:4";
}
function cropRect() {
  sanitizeCrop();
  const [aw, ah] = crop.aspect.split(":").map(Number);
  const target = aw / ah, frame = frameAspect();
  // Largest rectangle of the target aspect that fits the frame, scaled by `size`.
  let w = target < frame ? target / frame : 1, h = target < frame ? 1 : frame / target;
  w *= crop.size; h *= crop.size;
  const x = Math.min(1 - w, Math.max(0, crop.cx - w / 2)), y = Math.min(1 - h, Math.max(0, crop.cy - h / 2));
  return { x, y, w, h };
}
function renderCrop() {
  const box = $("#crop-box"), grid = $("#grid-overlay");
  box.hidden = !crop.enabled;
  $("#crop-panel").hidden = !crop.enabled;
  $("#toggle-crop").checked = crop.enabled;
  $("#crop-aspect").value = crop.aspect;
  $("#crop-size").value = Math.round(crop.size * 100);
  const r = crop.enabled ? cropRect() : { x: 0, y: 0, w: 1, h: 1 };
  for (const elm of [box, grid]) {  // the grid follows the crop
    Object.assign(elm.style, { left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.w * 100 + "%", height: r.h * 100 + "%",
                               right: "auto", bottom: "auto" });
  }
  const s = info.still_size || info.sensor_resolution;
  $("#crop-info").textContent = s ? `Photos: ${Math.round(r.w * s[0])} × ${Math.round(r.h * s[1])} px` : "";
}
let cropSaveTimer = null;
function saveCrop() {
  renderCrop();
  clearTimeout(cropSaveTimer);
  cropSaveTimer = setTimeout(() => {
    const r = cropRect();
    api("/api/settings", "POST", { crop: { ...crop, x: r.x, y: r.y, w: r.w, h: r.h } }).catch((e) => say(e.message, true));
  }, 300);
}
$("#toggle-crop").addEventListener("change", (e) => { crop.enabled = e.target.checked; saveCrop(); });
$("#crop-aspect").addEventListener("change", (e) => { crop.aspect = e.target.value; saveCrop(); });
$("#crop-size").addEventListener("input", (e) => { crop.size = e.target.value / 100; saveCrop(); });
$("#crop-center").addEventListener("click", () => { crop.cx = 0.5; crop.cy = 0.5; saveCrop(); });
// Drag the frame to move it; a click without moving still sets the focus point.
(() => {
  const box = $("#crop-box");
  let start = null;
  box.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const r = cropRect();
    start = { x: e.clientX, y: e.clientY, cx: r.x + r.w / 2, cy: r.y + r.h / 2, moved: false };
  });
  box.addEventListener("pointermove", (e) => {
    if (!start) return;
    const pr = $("#preview").getBoundingClientRect();
    const dx = (e.clientX - start.x) / pr.width, dy = (e.clientY - start.y) / pr.height;
    if (Math.abs(dx) + Math.abs(dy) > 0.004) start.moved = true;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const r = cropRect();
    crop.cx = Math.min(1 - r.w / 2, Math.max(r.w / 2, start.cx + dx));
    crop.cy = Math.min(1 - r.h / 2, Math.max(r.h / 2, start.cy + dy));
    renderCrop();
  });
  const end = (e) => {
    if (!start) return;
    const moved = start.moved;
    start = null;
    if (moved) saveCrop(); else setFocusPoint(e);
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", () => { start = null; });
})();
function loadCrop() {
  if (settings.crop) {
    const { enabled, aspect, size, cx, cy } = settings.crop;  // x/y/w/h are derived, not state
    crop = { ...crop, enabled: !!enabled, aspect, size, cx, cy };
  }
  sanitizeCrop();
  const ps = settings.camera?.preview_size;
  if (ps) $("#preview-wrap").style.setProperty("--ar", ps[0] / ps[1]);
  renderCrop();
}

// ---------------------------------------------------------------- viewer
const isTiff = (name) => /\.tiff?$/i.test(name);
function openViewer(title, url, isVideo = false) {
  $("#viewer-title").textContent = title;
  $("#viewer-download").href = url + (url.includes("?") ? "&" : "?") + "download=1";
  $("#viewer-download-png").hidden = !isTiff(title);
  $("#viewer-download-png").href = url + "?as=png";
  // Browsers cannot display TIFF: show a screen-sized JPEG preview instead.
  const shown = isTiff(title) ? url.replace("/media/", "/thumb/") + "?size=large" : url;
  $("#viewer-body").replaceChildren(isVideo
    ? el("video", { src: url, controls: true, autoplay: true })
    : el("a", { href: shown, target: "_blank" }, el("img", { src: shown, alt: title })));
  $("#viewer").showModal();
}
$("#viewer-close").addEventListener("click", () => { $("#viewer").close(); $("#viewer-body").replaceChildren(); });

function uploadButtons(kind, name) {
  const mk = (dest, text) => el("button", { onclick: () => guarded(async () => {
    const r = await api("/api/upload", "POST", { dest, kind, name });
    say(`Upload to ${dest} started`);
    watchJob(r.job);
  }) }, text);
  return [info.drive ? mk("drive", "→ Drive") : null, info.nas ? mk("nas", "→ NAS") : null];
}

function deleteButton(url, what, after) {
  return el("button", { class: "danger", onclick: () => guarded(async () => {
    if (!confirm(`Permanently delete ${what}?`)) return;
    await api(url, "DELETE");
    after();
  }) }, "Delete");
}

// ---------------------------------------------------------------- multi-select (gallery & stacks)
// selection keys look like "photos:name", "videos:name", "stacks:name"
const selection = { gallery: new Set(), stacks: new Set() };
const lastPicked = { gallery: null, stacks: null };

function pickBox(group, key) {
  const box = el("input", { type: "checkbox", checked: selection[group].has(key), "data-pick": key,
    "aria-label": "Select" });
  box.addEventListener("click", (e) => {
    const boxes = [...document.querySelectorAll(`[data-group="${group}"] input[data-pick]`)];
    if (e.shiftKey && lastPicked[group]) {  // range from the last clicked item
      const i = boxes.findIndex((b) => b.dataset.pick === lastPicked[group]);
      const j = boxes.indexOf(box);
      if (i >= 0) boxes.slice(Math.min(i, j), Math.max(i, j) + 1).forEach((b) => { b.checked = box.checked; });
    }
    lastPicked[group] = key;
    boxes.forEach((b) => { b.checked ? selection[group].add(b.dataset.pick) : selection[group].delete(b.dataset.pick); });
    updateSelectbar(group);
  });
  return el("label", { class: "pick", title: "Select (shift-click for a range)" }, box, "select");
}

function updateSelectbar(group) {
  const bar = document.querySelector(`.selectbar[data-kind="${group}"]`);
  const n = selection[group].size;
  bar.querySelector(".sel-delete").disabled = !n;
  bar.querySelector(".sel-delete").textContent = n ? `Delete selected (${n})` : "Delete selected";
  document.querySelectorAll(`[data-group="${group}"] input[data-pick]`).forEach((b) => {
    b.closest(".card")?.classList.toggle("selected", b.checked);
  });
}

function pruneSelection(group, existing) {
  for (const key of [...selection[group]]) if (!existing.has(key)) selection[group].delete(key);
}

document.querySelectorAll(".selectbar").forEach((bar) => {
  const group = bar.dataset.kind;
  const reload = group === "gallery" ? () => loadGallery() : () => loadStacks();
  bar.querySelector(".sel-all").addEventListener("click", () => {
    document.querySelectorAll(`[data-group="${group}"] input[data-pick]`).forEach((b) => {
      if (!b.disabled) { b.checked = true; selection[group].add(b.dataset.pick); }
    });
    updateSelectbar(group);
  });
  bar.querySelector(".sel-none").addEventListener("click", () => {
    selection[group].clear();
    document.querySelectorAll(`[data-group="${group}"] input[data-pick]`).forEach((b) => { b.checked = false; });
    updateSelectbar(group);
  });
  bar.querySelector(".sel-delete").addEventListener("click", () => guarded(async () => {
    const keys = [...selection[group]];
    if (!keys.length) return;
    const counts = {};
    keys.forEach((k) => { const kind = k.split(":")[0]; counts[kind] = (counts[kind] || 0) + 1; });
    const what = Object.entries(counts).map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "") : k}`).join(", ");
    if (!confirm(`Permanently delete ${what}?` + (group === "stacks" ? "\n\nThis removes each stack with all its frames and results." : ""))) return;
    const body = { photos: [], videos: [], stacks: [] };
    keys.forEach((k) => { const i = k.indexOf(":"); body[k.slice(0, i)].push(k.slice(i + 1)); });
    const r = await api("/api/delete", "POST", body);
    r.deleted.forEach((d) => selection[group].delete(`${d.kind}:${d.name}`));
    const msg = `Deleted ${r.deleted.length}` + (r.failed.length
      ? ` — ${r.failed.length} skipped: ${r.failed.map((f) => `${f.name} (${f.error})`).join("; ")}` : "");
    await reload();  // rebuilds the list (and the stacks message line) first
    say(msg, r.failed.length > 0, group === "stacks" ? "#stacks-msg" : "#message");
    if (group === "gallery") alert(msg);
  }, group === "stacks" ? "#stacks-msg" : "#message"));
});

// ---------------------------------------------------------------- gallery
async function loadGallery() {
  const [p, v] = await Promise.all([api("/api/photos"), api("/api/videos")]);
  const photos = $("#photos");
  photos.replaceChildren();
  photos.dataset.group = "gallery";
  pruneSelection("gallery", new Set([...p.photos.map((f) => `photos:${f.name}`), ...v.videos.map((f) => `videos:${f.name}`)]));
  if (!p.photos.length) photos.append(el("p", { class: "muted" }, "No photos yet."));
  for (const f of p.photos) {
    const url = `/media/photos/${enc(f.name)}`;
    photos.append(el("figure", { class: "card" },
      el("img", { src: `/thumb/photos/${enc(f.name)}`, loading: "lazy", alt: f.name,
        onclick: () => openViewer(f.name, url) }),
      el("figcaption", {}, pickBox("gallery", `photos:${f.name}`), el("div", { class: "small" }, f.name), el("div", { class: "muted small" }, `${f.modified.replace("T", " ")} · ${fmtBytes(f.size)}`)),
      el("div", { class: "row" },
        el("a", { class: "button", href: url + "?download=1" }, "Download"),
        isTiff(f.name) ? el("a", { class: "button", href: url + "?as=png", title: "Compressed on the Pi first (~10-15 s on a Pi 3B)" }, "Download PNG") : null,
        uploadButtons("photo", f.name),
        deleteButton(`/api/photos/${enc(f.name)}`, f.name, loadGallery))));
  }
  const videos = $("#videos");
  videos.replaceChildren();
  videos.dataset.group = "gallery";
  if (!v.videos.length) videos.append(el("p", { class: "muted" }, "No videos yet."));
  for (const f of v.videos) {
    const url = `/media/videos/${enc(f.name)}`;
    videos.append(el("div", { class: "card row" },
      pickBox("gallery", `videos:${f.name}`),
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(f.name, url, true); } }, f.name),
      el("span", { class: "muted small" }, `${f.modified.replace("T", " ")} · ${fmtBytes(f.size)}`),
      el("a", { class: "button", href: url + "?download=1" }, "Download"),
      uploadButtons("video", f.name),
      deleteButton(`/api/videos/${enc(f.name)}`, f.name, loadGallery)));
  }
  updateSelectbar("gallery");
}
$("#btn-gallery-refresh").addEventListener("click", loadGallery);

// ---------------------------------------------------------------- stacks
function stackCard(s) {
  const base = `/media/stacks/${enc(s.name)}/`;
  const thumbOf = (f) => `/thumb/stacks/${enc(s.name)}/${enc(f)}`;
  const cover = s.outputs.result || s.frames[Math.floor(s.frames.length / 2)];
  const jobText = s.job?.status === "queued" && s.job.position ? `queued #${s.job.position}`
    : s.job?.status === "running" ? "processing…" : `processing: ${s.job?.status}`;
  const jobInfo = s.job ? el("span", { class: "badge " + ({ done: "ok", error: "warn" })[s.job.status] }, jobText) : null;
  const frames = el("div", { class: "frames", hidden: true },
    s.frames.map((f) => el("figure", {},
      el("img", { src: thumbOf(f), loading: "lazy", alt: f, onclick: () => openViewer(f, base + enc(f)) }),
      el("figcaption", { class: "small" }, f.replace(s.name + "_", "#"),
        s.open ? null : el("button", { class: "tiny danger", title: "Delete frame", onclick: () => guarded(async () => {
          if (!confirm(`Delete frame ${f}?`)) return;
          await api(`/api/stacks/${enc(s.name)}/${enc(f)}`, "DELETE");
          loadStacks();
        }) }, "✕")))));
  return el("div", { class: "card stack" },
    el("div", { class: "row" },
      cover ? el("img", { class: "cover", src: thumbOf(cover), alt: s.name, onclick: () => openViewer(cover, base + enc(cover)) }) : null,
      el("div", {},
        s.open ? null : pickBox("stacks", `stacks:${s.name}`),
        el("strong", {}, s.name),
        el("div", { class: "muted small" }, `${s.frames.length} frames · ${s.created ? s.created.replace("T", " ") : ""}`),
        el("div", { class: "row" },
          s.outputs.result ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.result, base + enc(s.outputs.result)); } }, "result") : el("span", { class: "muted small" }, "not processed"),
          s.outputs.depthmap ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.depthmap, base + enc(s.outputs.depthmap)); } }, "depth map") : null,
          jobInfo, s.open ? el("span", { class: "badge", title: "Still taking frames — press Finish to close it" }, "open") : null))),
    el("div", { class: "row" },
      processButton(s),
      s.outputs.result && s.frames.length && !s.open ? el("button", { onclick: () => guarded(async () => {
        if (!confirm(`Delete the ${s.frames.length} source frames of ${s.name}? The result is kept.`)) return;
        await api(`/api/stacks/${enc(s.name)}/frames`, "DELETE");
        loadStacks();
      }, "#stacks-msg") }, "Delete source frames") : null,
      s.frames.length ? el("button", { onclick: () => { frames.hidden = !frames.hidden; } }, "Frames") : null,
      el("a", { class: "button", href: `/download/stack/${enc(s.name)}.zip` }, "Download zip"),
      s.outputs.result ? el("a", { class: "button", href: base + enc(s.outputs.result) + "?download=1" }, "Download result") : null,
      s.open ? null : uploadButtons("stack", s.name),
      s.open ? null : deleteButton(`/api/stacks/${enc(s.name)}`, `stack ${s.name} (all frames)`, loadStacks)),
    frames);
}

// AF cameras auto-stack, so there the button only appears as a retry for
// stacks that failed or never got processed.
function processButton(s) {
  const busy = s.job && ["queued", "running"].includes(s.job.status);
  if (s.open && !status.stack?.sweep) {
    // A manual stack stays open until Finish (Capture tab) — offer it here too.
    return el("button", { class: "primary", title: "Close this stack (same as Finish in the Capture tab)",
      onclick: () => { $("#btn-stack-end").click(); setTimeout(loadStacks, 1500); } }, "Finish stack");
  }
  if (s.open || busy || s.frames.length < 2 || !info.focus_stack?.available) {
    return info.has_autofocus ? null : el("button", { class: "primary", disabled: true }, "Process stack");
  }
  if (info.has_autofocus && s.outputs.result && s.job?.status !== "error") return null;
  const retry = info.has_autofocus || s.outputs.result;
  return el("button", { class: "primary", onclick: () => guarded(async () => {
    const r = await api(`/api/stack/process/${enc(s.name)}`, "POST", { options: processOptions() });
    say(`Processing ${s.name} started`);
    watchJob(r.job);
    loadStacks();
  }, "#stacks-msg") }, retry ? "Reprocess" : "Process stack");
}

// Per-run overrides for focus-stack; defaults come from the settings.
function processOptions() {
  const opts = {};
  document.querySelectorAll("#process-options [data-key]").forEach((i) => {
    opts[i.dataset.key] = i.type === "checkbox" ? i.checked : (i.value === "" ? "" : isNaN(+i.value) ? i.value : +i.value);
  });
  return opts;
}
function processOptionsBox() {
  const fs = settings.focus_stack || {};
  const box = el("details", { id: "process-options", class: "card" }, el("summary", {}, "Stacking options for this run"));
  for (const [key, meta] of Object.entries(FOCUS_STACK_FIELDS)) box.append(fieldFor(key, meta, fs[key]));
  return box;
}

async function loadStacks() {
  if (!settings.focus_stack) await loadSettings();
  const r = await api("/api/stacks");
  const box = $("#stacks");
  const openDetails = $("#process-options")?.open;
  const keep = $("#process-options") ? processOptions() : null;
  box.replaceChildren(el("div", { id: "stacks-msg", class: "status" }), processOptionsBox());
  if (keep) document.querySelectorAll("#process-options [data-key]").forEach((i) => {
    if (i.type === "checkbox") i.checked = keep[i.dataset.key]; else i.value = keep[i.dataset.key];
  });
  $("#process-options").open = !!openDetails;
  if (!info.focus_stack?.available) box.append(el("p", { class: "error" }, "No stacker available — run ./install.sh on the Pi (builds focus-stack, installs python3-opencv)."));
  if (!r.stacks.length) box.append(el("p", { class: "muted" }, "No stacks yet."));
  box.dataset.group = "stacks";
  pruneSelection("stacks", new Set(r.stacks.filter((s) => !s.open).map((s) => `stacks:${s.name}`)));
  r.stacks.forEach((s) => box.append(stackCard(s)));
  updateSelectbar("stacks");
  const all = $("#btn-stacks-process-all");
  all.hidden = !r.unprocessed || !info.focus_stack?.available;
  all.textContent = `Process all unprocessed stacks (${r.unprocessed})`;
  // Keep the queue positions fresh while stacks are waiting or running.
  clearTimeout(stacksTimer);
  if (!$("#tab-stacks").hidden && r.stacks.some((s) => s.job && ["queued", "running"].includes(s.job.status))) {
    stacksTimer = setTimeout(() => loadStacks().catch(() => {}), 5000);
  }
}
$("#btn-stacks-refresh").addEventListener("click", loadStacks);
let stacksTimer = null;
$("#btn-stacks-process-all").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/stacks/process_all", "POST", { options: processOptions() });
  say(`${r.queued} stack(s) queued — they are processed one after another.`, false, "#stacks-msg");
  r.jobs.forEach(watchJob);
  loadStacks();
}, "#stacks-msg"));
$("#btn-jobs-refresh").addEventListener("click", loadJobs);
$("#btn-jobs-clear").addEventListener("click", async () => {
  await api("/api/jobs/clear", "POST", {}).catch((e) => alert(e.message));
  loadJobs();
});

// ---------------------------------------------------------------- settings
const FOCUS_STACK_FIELDS = {
  method: { label: "Method (halofree = no glow around edges on a black backdrop; focus-stack = classic wavelet stacking)", options: ["halofree", "focus-stack"] },
  halofree_threshold: { label: "Halo-free: detail threshold (× noise; higher = less backdrop noise counted as detail)", type: "number" },
  halofree_band: { label: "Halo-free: halo band around the model (pixels at half size)", type: "number" },
  output_format: { label: "Output format", options: ["png", "jpg", "tif"] },
  consistency: { label: "Consistency (0-2)", type: "number" },
  denoise: { label: "Denoise", type: "number", step: "0.1" },
  threads: { label: "Threads (empty = auto: 1 on a 1 GB Pi 3B, more with more RAM)", type: "number" },
  batchsize: { label: "Batch size (0 = all frames in one batch; Pi 3B: 2-4 because of RAM)", type: "number" },
  delete_frames: { label: "Delete source frames after a successful stack", type: "checkbox" },
  jpgquality: { label: "JPG quality", type: "number" },
  reference: { label: "Reference frame (index, empty = middle)", type: "number" },
  remove_bg: { label: "Remove background (+ black / − white, empty = off)", type: "number" },
  global_align: { label: "Global align", type: "checkbox" },
  full_resolution_align: { label: "Full-resolution align", type: "checkbox" },
  no_whitebalance: { label: "No white balance correction", type: "checkbox" },
  no_contrast: { label: "No contrast correction", type: "checkbox" },
  no_transform: { label: "No position alignment", type: "checkbox" },
  no_align: { label: "Skip alignment completely", type: "checkbox" },
  align_keep_size: { label: "Keep original size", type: "checkbox" },
  nocrop: { label: "Do not crop", type: "checkbox" },
  no_opencl: { label: "No OpenCL (Pi: on)", type: "checkbox" },
  depthmap: { label: "Save depth map", type: "checkbox" },
  view3d: { label: "Save 3D preview", type: "checkbox" },
  verbose: { label: "Verbose log", type: "checkbox" },
  extra_args: { label: "Extra arguments", type: "text" },
};

function fieldFor(key, meta, value) {
  let input;
  if (meta.options) {
    input = el("select", { "data-key": key }, meta.options.map((o) => el("option", { value: o, selected: o === value }, o)));
  } else if (meta.type === "checkbox") {
    input = el("input", { type: "checkbox", "data-key": key, checked: !!value });
  } else {
    input = el("input", { type: meta.type || "text", step: meta.step || (meta.type === "number" ? "any" : null), "data-key": key, value: value ?? "" });
  }
  const info = infoIcon(key);
  return el("label", { class: meta.type === "checkbox" ? "check" : "block" },
    meta.type === "checkbox" ? [input, " " + meta.label, info] : [el("span", {}, meta.label, info), input]);
}

// ⓘ next to a setting: hover shows the text on a computer, a tap/click opens a
// small popover (touch screens have no hover).
const helpPop = el("div", { id: "help-pop", role: "tooltip", hidden: true });
document.body.append(helpPop);
function infoIcon(key) {
  const text = typeof HELP !== "undefined" && HELP[key];
  if (!text) return null;
  return el("button", { class: "info", type: "button", "aria-label": `What is ${key}?`, title: text,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); showHelp(e.currentTarget, text); } }, "ⓘ");
}
function showHelp(anchor, text) {
  if (!helpPop.hidden && helpPop.textContent === text) { helpPop.hidden = true; return; }
  helpPop.textContent = text;
  helpPop.hidden = false;
  const r = anchor.getBoundingClientRect(), w = Math.min(340, window.innerWidth - 24);
  helpPop.style.width = w + "px";
  helpPop.style.left = Math.max(12, Math.min(r.left - 12, window.innerWidth - w - 12)) + "px";
  const below = r.bottom + 6, h = helpPop.offsetHeight;
  helpPop.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below) + "px";
}
document.addEventListener("click", (e) => { if (!helpPop.contains(e.target)) helpPop.hidden = true; });
window.addEventListener("scroll", () => { helpPop.hidden = true; }, true);

const SETTINGS_SECTIONS = [
  ["Files", null, {
    filename_pattern: { label: "File name pattern ({dt:%Y%m%d_%H%M%S}, {label}, {seq:03d})", type: "text" },
    next_seq: { label: "Next {seq}", type: "number" },
    image_format: { label: "Image format (tif = no compression work, ~1.8× larger; png = compressed in the background)", options: ["png", "tif", "jpg"] },
    png_compress_level: { label: "PNG compression (0-9, lossless; lower = faster)", type: "number" },
    jpeg_quality: { label: "JPG quality", type: "number" },
    save_metadata: { label: "Save metadata sidecar (.json)", type: "checkbox" },
    persist_controls: { label: "Remember camera controls after restart (when no boot preset is set)", type: "checkbox" },
  }],
  ["Camera & performance", "camera", {
    lock_exposure_in_stacks: { label: "Lock exposure & white balance during a stack (prevents brightness/colour shifts between frames — a common cause of halos)", type: "checkbox" },
    preview_mode: { label: "Live preview (fast = binned sensor mode, switches to full-res for each capture; full = always full-res, slower preview)", options: ["fast", "full"] },
    save_queue: { label: "Frames waiting to be written (each ~36 MB RAM; Pi 3B: 2)", type: "number" },
    compress_workers: { label: "Compression workers (0 = one per CPU core minus one; applies after restart)", type: "number" },
  }],
  ["Upload", "upload", {
    auto_drive: { label: "Upload to Google Drive automatically (when connected)", type: "checkbox" },
    rclone_remote: { label: "Drive folder (rclone remote:path, e.g. gdrive:MiniatureStudio)", type: "text" },
    auto_nas: { label: "Copy to NAS automatically", type: "checkbox" },
    nas_path: { label: "NAS folder (on the mounted share)", type: "text" },
    nas_require_mount: { label: "Refuse when the NAS folder is not on a mounted share", type: "checkbox" },
    stack_frames: { label: "Also upload all stack frames (otherwise only the result)", type: "checkbox" },
  }],
  ["Lens sweep (AF cameras)", "sweep", {
    start: { label: "Start LensPosition", type: "number", step: "0.05" },
    end: { label: "End LensPosition", type: "number", step: "0.05" },
    steps: { label: "Steps", type: "number" },
    settle_ms: { label: "Settle time per step (ms)", type: "number" },
  }],
  ["Stacking default options", "focus_stack", FOCUS_STACK_FIELDS],
];

async function loadSettings() {
  const r = await api("/api/settings");
  settings = r.settings;
  const form = $("#settings-form");
  form.replaceChildren();
  for (const [title, section, fields] of SETTINGS_SECTIONS) {
    const values = section ? settings[section] : settings;
    const fs = el("fieldset", { "data-section": section || "" }, el("legend", {}, title));
    for (const [key, meta] of Object.entries(fields)) fs.append(fieldFor(key, meta, values[key]));
    form.append(fs);
  }
  form.append(el("p", { class: "muted small" }, `Example: ${r.example_name}. Preview/video resolution live in config.json (restart needed).`));
  const sw = settings.sweep;
  if (sw && !$("#sweep-start").value) {
    $("#sweep-start").value = sw.start; $("#sweep-end").value = sw.end;
    $("#sweep-steps").value = sw.steps; $("#sweep-settle").value = sw.settle_ms;
  }
  updateNameExample();
  renderBadges();
}

$("#btn-settings-save").addEventListener("click", (e) => { e.preventDefault(); guarded(async () => {
  const body = {};
  document.querySelectorAll("#settings-form fieldset").forEach((fs) => {
    const target = fs.dataset.section ? (body[fs.dataset.section] = {}) : body;
    fs.querySelectorAll("[data-key]").forEach((i) => {
      let v = i.type === "checkbox" ? i.checked : i.value;
      if (i.type === "number" && v !== "") v = +v;
      target[i.dataset.key] = v;
    });
  });
  await api("/api/settings", "POST", body);
  say("Saved", false, "#settings-message");
  await loadSettings();
  info = await api("/api/camera_info");
  renderBadges();
}, "#settings-message"); });

// ---------------------------------------------------------------- storage: SD card / USB disk
const gb = (n) => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " GB";
let storageState = {};

async function loadStorage() {
  const r = storageState = await api("/api/storage");
  const usbName = r.usb.label || r.usb.uuid || "USB disk";
  const where = r.target === "usb"
    ? (r.usb_mounted ? `USB disk “${usbName}” — ${gb(r.free.usb.free)} free` : `USB disk “${usbName}” — NOT CONNECTED`)
    : `SD card — ${r.free.sd ? gb(r.free.sd.free) : "?"} free`;
  $("#storage-status").replaceChildren("Saving to: ", el("strong", {}, where));
  $("#storage-status").className = r.target === "usb" && !r.usb_mounted ? "error" : "";

  const list = $("#usb-disks");
  list.replaceChildren();
  const disks = r.disks.filter((d) => !(r.target === "usb" && d.uuid === r.usb.uuid && r.usb_mounted));
  if (!disks.length && !(r.target === "usb" && r.usb_mounted)) {
    list.append(el("p", { class: "muted small" }, "No USB disks found. Plug one in and click “Look for USB disks”."));
  }
  for (const d of disks) {
    const name = `${d.label || d.model || d.path} (${d.fstype}, ${gb(d.size)})`;
    list.append(el("div", { class: "card row" },
      el("span", {}, name),
      d.supported
        ? el("button", { class: "primary", onclick: () => useUsb(d, name) }, "Use this disk")
        : el("span", { class: "muted small" }, `${d.fstype} is not supported — format it as exFAT or ext4`)));
  }
  $("#btn-storage-eject").hidden = !(r.target === "usb" && r.usb_mounted);
  $("#btn-storage-sd").hidden = r.target !== "usb";
  $("#btn-storage-forget").hidden = !(r.usb.configured && r.target !== "usb");
}

// After switching, offer to move the existing files along (runs as a background job).
async function offerMove(direction, data, what) {
  if (!data || !data.files) return;
  if (!confirm(`Move your existing photos, stacks and videos (${data.files} files, ${gb(data.bytes)}) ${what}?\n\n` +
               "This runs in the background; each file is deleted from the old place only after it has been copied.")) return;
  const r = await api("/api/storage/move", "POST", { direction });
  say("Moving files in the background — see the Jobs tab for progress.", false, "#storage-message");
  watchJob(r.job);
}

async function useUsb(disk, name) {
  await guarded(async () => {
    if (!confirm(`Store new photos on ${name}?\n\nNothing on the disk is erased; a MiniatureStudio folder is created.`)) return;
    say("Mounting…", false, "#storage-message");
    const r = await api("/api/storage/usb", "POST", { uuid: disk.uuid });
    say("New captures are now saved to the USB disk.", false, "#storage-message");
    await loadStorage();
    await offerMove("to_usb", r.sd_data, "from the SD card to the USB disk");
  }, "#storage-message");
}

$("#btn-storage-refresh").addEventListener("click", () => guarded(loadStorage, "#storage-message"));
$("#btn-storage-eject").addEventListener("click", () => guarded(async () => {
  await api("/api/storage/eject", "POST", {});
  say("You can unplug the disk now. Captures are paused until it is plugged back in (or you switch to the SD card).",
      false, "#storage-message");
  loadStorage();
}, "#storage-message"));
$("#btn-storage-sd").addEventListener("click", () => guarded(async () => {
  if (!confirm("Save new captures to the SD card again?")) return;
  const r = await api("/api/storage/sd", "POST", {});
  say("New captures are saved to the SD card again. The USB disk stays mounted until you forget it.", false, "#storage-message");
  await loadStorage();
  await offerMove("to_sd", r.usb_data, "from the USB disk back to the SD card");
}, "#storage-message"));
$("#btn-storage-forget").addEventListener("click", () => guarded(async () => {
  if (!confirm("Unmount the USB disk and stop mounting it at boot? Files on the disk are not touched.")) return;
  await api("/api/storage/sd", "POST", { forget: true });
  say("USB disk forgotten — you can unplug it.", false, "#storage-message");
  loadStorage();
}, "#storage-message"));

// ---------------------------------------------------------------- connections: Google Drive
async function loadDrive() {
  const r = await api("/api/drive/status");
  $("#drive-status").textContent = !r.rclone ? "rclone is not installed."
    : r.connected ? `Connected — files go to ${r.remote}` : "Not connected.";
  $("#drive-status").className = r.connected ? "ok-text" : "muted";
  $("#btn-drive-connect").textContent = r.connected ? "Reconnect Google Drive" : "Connect Google Drive";
  $("#btn-drive-connect").disabled = !r.rclone;
  $("#btn-drive-disconnect").hidden = !r.connected;
}
$("#btn-drive-connect").addEventListener("click", () => guarded(async () => {
  say("Starting authorization…", false, "#drive-message");
  const r = await api("/api/drive/connect/start", "POST", {});
  $("#drive-auth-link").href = r.url;
  $("#drive-flow").hidden = false;
  $("#drive-redirect").value = "";
  window.open(r.url, "_blank", "noopener");
  say("Sign in with Google in the new tab, then paste the address you end up on.", false, "#drive-message");
}, "#drive-message"));
$("#btn-drive-finish").addEventListener("click", () => guarded(async () => {
  say("Finishing…", false, "#drive-message");
  const r = await api("/api/drive/connect/finish", "POST", { url: $("#drive-redirect").value });
  $("#drive-flow").hidden = true;
  say(`Google Drive connected (${r.remote}).`, false, "#drive-message");
  info = await api("/api/camera_info");
  loadDrive();
  renderBadges();
}, "#drive-message"));
$("#btn-drive-disconnect").addEventListener("click", () => guarded(async () => {
  if (!confirm("Disconnect Google Drive? Files already uploaded stay on Drive.")) return;
  await api("/api/drive/disconnect", "POST", {});
  say("Disconnected.", false, "#drive-message");
  info = await api("/api/camera_info");
  loadDrive();
  renderBadges();
}, "#drive-message"));

// ---------------------------------------------------------------- connections: NAS
function updateNasForm() {
  const smb = $("#nas-type").value === "smb";
  document.querySelectorAll("#nas-form .smb-only").forEach((n) => { n.hidden = !smb; });
  $("#nas-share").placeholder = smb ? "photos" : "/volume1/photos";
}
$("#nas-type").addEventListener("change", updateNasForm);
async function loadNas() {
  const r = await api("/api/nas/status");
  if (r.configured) {
    const src = r.type === "smb" ? `//${r.server}/${r.share}` : `${r.server}:/${r.share}`;
    $("#nas-status").textContent = `${r.mounted ? "Mounted" : "Configured (not mounted)"}: ${src} → ${r.mount_point}. Files go to ${r.nas_path}`;
    $("#nas-type").value = r.type; $("#nas-server").value = r.server; $("#nas-share").value = r.share;
    $("#nas-mount-point").value = r.mount_point; $("#nas-username").value = r.username || "";
    $("#nas-domain").value = r.domain || ""; $("#nas-version").value = r.version || "";
  } else {
    $("#nas-status").textContent = r.error ? `Not available: ${r.error}` : "No NAS mounted.";
  }
  $("#btn-nas-unmount").hidden = !r.configured;
  $("#btn-nas-mount").textContent = r.configured ? "Save & remount" : "Mount NAS";
  updateNasForm();
}
$("#btn-nas-mount").addEventListener("click", () => guarded(async () => {
  say("Mounting…", false, "#nas-message");
  const r = await api("/api/nas/mount", "POST", {
    type: $("#nas-type").value, server: $("#nas-server").value.trim(), share: $("#nas-share").value.trim(),
    mount_point: $("#nas-mount-point").value.trim(), username: $("#nas-username").value,
    password: $("#nas-password").value, domain: $("#nas-domain").value, version: $("#nas-version").value,
  });
  $("#nas-password").value = "";
  say(`Mounted. Files go to ${r.nas_path}`, false, "#nas-message");
  info = await api("/api/camera_info");
  loadNas();
  loadSettings();
}, "#nas-message"));
$("#btn-nas-unmount").addEventListener("click", () => guarded(async () => {
  if (!confirm("Unmount the NAS and remove it from /etc/fstab? Files on the NAS are not touched.")) return;
  await api("/api/nas/unmount", "POST", {});
  say("Unmounted.", false, "#nas-message");
  info = await api("/api/camera_info");
  loadNas();
}, "#nas-message"));

// ---------------------------------------------------------------- updates
async function loadVersion() {
  try { $("#version").textContent = (await api("/api/version")).version; } catch (_) { /* ignore */ }
}
$("#btn-update-check").addEventListener("click", () => guarded(async () => {
  $("#update-info").textContent = "Checking…";
  const r = await api("/api/update/check", "POST", {});
  $("#btn-update-apply").hidden = r.behind === 0;
  $("#update-info").replaceChildren(r.behind === 0
    ? "You are running the latest version."
    : el("div", {}, `${r.behind} new change(s):`, el("pre", { class: "log" }, r.changes.join("\n"))));
}, "#update-info"));
$("#btn-update-apply").addEventListener("click", () => guarded(async () => {
  if (!confirm("Install the update? The app restarts automatically afterwards.")) return;
  const r = await api("/api/update/apply", "POST", {});
  $("#btn-update-apply").disabled = true;
  const log = el("pre", { class: "log" });
  $("#update-info").replaceChildren("Updating…", log);
  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${r.job}`); } catch (_) { return setTimeout(waitForRestart, 2000); }
    log.textContent = job.log.join("\n");
    if (job.status === "error") { $("#update-info").prepend(el("div", { class: "error" }, job.error)); $("#btn-update-apply").disabled = false; return; }
    if (job.status === "done") return job.result?.restarting ? setTimeout(waitForRestart, 3000) : null;
    setTimeout(tick, 1500);
  };
  const waitForRestart = async () => {
    try { await api("/api/version"); location.reload(); } catch (_) { setTimeout(waitForRestart, 2000); }
  };
  tick();
}, "#update-info"));

// ---------------------------------------------------------------- remember view options (per browser)
const REMEMBERED = ["toggle-grid", "toggle-focus", "toggle-histogram", "toggle-clipping", "stack-autoprocess"];
function store(key, value) { try { localStorage.setItem("ms." + key, JSON.stringify(value)); } catch (_) { /* private mode */ } }
function recall(key) { try { const v = localStorage.getItem("ms." + key); return v === null ? undefined : JSON.parse(v); } catch (_) { return undefined; } }
REMEMBERED.forEach((id) => $("#" + id).addEventListener("change", (e) => store(id, e.target.checked)));
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => store("tab", b.dataset.tab)));
function restoreView() {
  REMEMBERED.forEach((id) => {
    const v = recall(id), box = $("#" + id);
    if (typeof v === "boolean" && v !== box.checked) {
      box.checked = v;
      box.dispatchEvent(new Event("change"));  // runs the normal handlers (overlay, histogram, focus check)
    }
  });
  const tab = recall("tab");
  const btn = tab && document.querySelector(`#tabs button[data-tab="${tab}"]`);
  if (btn) btn.click();
}

// ---------------------------------------------------------------- init
(async function init() {
  // Right after an update the app may still be restarting: retry instead of showing
  // "focus-stack missing" and friends based on an empty answer.
  for (let attempt = 0; ; attempt++) {
    try { info = await api("/api/camera_info"); break; } catch (e) {
      if (attempt >= 15) { say(e.message, true); break; }
      say("Waiting for the app to start…");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if ($("#message").textContent === "Waiting for the app to start…") say("");
  $("#no-camera-notice").hidden = !info.camera_error;
  $("#btn-af").hidden = !info.has_autofocus;
  $("#stack-mode").hidden = !info.has_autofocus;
  const mode = recall("stackMode") || "sweep";
  const radio = document.querySelector(`input[name="stack-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  showStackMode();
  if (info.lens_range) {
    const [lo, hi] = info.lens_range;
    ["#sweep-start", "#sweep-end"].forEach((s) => { $(s).min = lo; $(s).max = hi; });
  }
  await guarded(loadSettings);
  loadCrop();
  restoreView();
  loadVersion();
  refreshStatus();
  setInterval(refreshStatus, 1500);
  setInterval(pollLens, 2000);
  // Resume watching jobs that were running before a page reload.
  try { (await api("/api/jobs")).jobs.filter((j) => ["queued", "running"].includes(j.status)).forEach((j) => watchJob(j.id)); } catch (_) { /* ignore */ }
})();
