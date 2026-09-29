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
  };
  (loaders[btn.dataset.tab] || []).forEach((fn) => fn().catch((e) => console.warn(e)));
}));

// ---------------------------------------------------------------- badges / status
function renderBadges() {
  const b = $("#badges");
  b.replaceChildren();
  if (info.demo) b.append(el("span", { class: "badge warn" }, "DEMO (no camera)"));
  else if (info.model) b.append(el("span", { class: "badge" }, info.model));
  b.append(el("span", { class: "badge " + (info.focus_stack?.available ? "ok" : "warn"),
    title: info.focus_stack?.binary || "run ./install.sh" },
    info.focus_stack?.available ? "focus-stack ✓" : "focus-stack missing"));
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
  const err = status.saving?.last_error || status.compressing?.last_error;
  if (err) b.append(el("span", { class: "badge warn", title: err }, "save error"));
}

async function refreshStatus() {
  try { status = await api("/api/status"); } catch (_) { return; }
  const stack = status.stack;
  $("#btn-stack-start").disabled = !!stack || status.recording.active;
  $("#btn-stack-frame").disabled = !stack || !!stack.sweep;
  $("#btn-stack-end").disabled = !stack || !!stack.sweep;
  $("#btn-sweep").disabled = !!stack || status.recording.active;
  $("#btn-sweep-cancel").hidden = !(stack && stack.sweep);
  $("#btn-photo").disabled = status.recording.active;
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
function showBusy(text, reason = "capture") {
  busyReasons.add(reason);
  $("#busy-text").textContent = text;
  $("#busy-overlay").hidden = false;
}
function hideBusy(reason = "capture") {
  busyReasons.delete(reason);
  if (!busyReasons.size) $("#busy-overlay").hidden = true;
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

$("#btn-stack-start").addEventListener("click", () => guarded(async () => {
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
$("#btn-sweep").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/stack/sweep", "POST", sweepBody());
  say(`Sweep ${r.name} started`);
  watchJob(r.job);
  refreshStatus();
}));
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
$("#preview").addEventListener("click", (e) => {
  const r = e.target.getBoundingClientRect();
  focusPoint = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  const m = $("#focus-marker");
  m.style.left = focusPoint.x * 100 + "%";
  m.style.top = focusPoint.y * 100 + "%";
  sharpMax = 0;
});
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
  focusTimer = setTimeout(focusLoop, 1000);
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
    try { await api("/api/controls", "POST", body); $("#live").classList.remove("error"); }
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
  const num = el("input", { type: "number", step: isFloat ? "any" : 1, min, max, class: "num" });
  const set = (v) => { if (v === null || v === undefined) return; num.value = isFloat ? +(+v).toFixed(4) : Math.round(v); range.value = toSlider(+v); };
  set(value);
  range.addEventListener("input", () => {
    const v = fromSlider(parseFloat(range.value));
    num.value = isFloat ? +v.toFixed(4) : Math.round(v);
    onChange(isFloat ? v : Math.round(v), idx);
  });
  num.addEventListener("change", () => { set(parseFloat(num.value)); onChange(parseFloat(num.value), idx); });
  return el("span", { class: "numctl" }, range, num);
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
  return el("div", { class: "control", "data-name": c.name.toLowerCase() },
    el("label", { title: `${JSON.stringify(c.min)} … ${JSON.stringify(c.max)}` }, c.name), input, reset);
}

let cameraState = {};
async function loadCameras() {
  cameraState = await api("/api/cameras");
  const r = cameraState;
  $("#camera-select").replaceChildren(...r.cameras.map((c) =>
    el("option", { value: c.index, selected: c.index === r.active },
      `${c.index}: ${c.model}${c.location !== null && c.location !== undefined ? ` (port ${c.location})` : ""}`
      + (c.index === r.default ? " ★ default" : ""))));
  $("#btn-camera-default").disabled = r.active === r.default;
}
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
  $("#controls").replaceChildren(...controlsDesc.map(controlRow));
  renderLive(r.live);
  applyFilter();
}
function renderLive(live) {
  $("#live").classList.remove("error");
  $("#live").textContent = Object.entries(live).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? v.map((x) => +(+x).toFixed(3)).join("/") : typeof v === "number" ? +v.toFixed(3) : v}`).join("  ·  ");
}
function applyFilter() {
  const q = $("#control-filter").value.toLowerCase();
  document.querySelectorAll(".control").forEach((row) => { row.hidden = q && !row.dataset.name.includes(q); });
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
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const l = (r * 54 + g * 183 + b * 19) >> 8;  // Rec.709 luma
        bins[0][r]++; bins[1][g]++; bins[2][b]++; bins[3][l]++;
        if (r >= 254 || g >= 254 || b >= 254) {
          high++;
          if (clip) { clip.data[i] = 255; clip.data[i + 3] = 200; }  // red where a channel blows out
        } else if (l <= 2) low++;
      }
      const n = px.length / 4;
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

// ---------------------------------------------------------------- gallery
async function loadGallery() {
  const [p, v] = await Promise.all([api("/api/photos"), api("/api/videos")]);
  const photos = $("#photos");
  photos.replaceChildren();
  if (!p.photos.length) photos.append(el("p", { class: "muted" }, "No photos yet."));
  for (const f of p.photos) {
    const url = `/media/photos/${enc(f.name)}`;
    photos.append(el("figure", { class: "card" },
      el("img", { src: `/thumb/photos/${enc(f.name)}`, loading: "lazy", alt: f.name,
        onclick: () => openViewer(f.name, url) }),
      el("figcaption", {}, el("div", { class: "small" }, f.name), el("div", { class: "muted small" }, `${f.modified.replace("T", " ")} · ${fmtBytes(f.size)}`)),
      el("div", { class: "row" },
        el("a", { class: "button", href: url + "?download=1" }, "Download"),
        isTiff(f.name) ? el("a", { class: "button", href: url + "?as=png", title: "Compressed on the Pi first (~10-15 s on a Pi 3B)" }, "Download PNG") : null,
        uploadButtons("photo", f.name),
        deleteButton(`/api/photos/${enc(f.name)}`, f.name, loadGallery))));
  }
  const videos = $("#videos");
  videos.replaceChildren();
  if (!v.videos.length) videos.append(el("p", { class: "muted" }, "No videos yet."));
  for (const f of v.videos) {
    const url = `/media/videos/${enc(f.name)}`;
    videos.append(el("div", { class: "card row" },
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(f.name, url, true); } }, f.name),
      el("span", { class: "muted small" }, `${f.modified.replace("T", " ")} · ${fmtBytes(f.size)}`),
      el("a", { class: "button", href: url + "?download=1" }, "Download"),
      uploadButtons("video", f.name),
      deleteButton(`/api/videos/${enc(f.name)}`, f.name, loadGallery)));
  }
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
        el("strong", {}, s.name),
        el("div", { class: "muted small" }, `${s.frames.length} frames · ${s.created ? s.created.replace("T", " ") : ""}`),
        el("div", { class: "row" },
          s.outputs.result ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.result, base + enc(s.outputs.result)); } }, "result") : el("span", { class: "muted small" }, "not processed"),
          s.outputs.depthmap ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.depthmap, base + enc(s.outputs.depthmap)); } }, "depth map") : null,
          jobInfo, s.open ? el("span", { class: "badge" }, "open") : null))),
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
  const box = el("details", { id: "process-options", class: "card" }, el("summary", {}, "focus-stack options for this run"));
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
  if (!info.focus_stack?.available) box.append(el("p", { class: "error" }, "focus-stack binary not found — run ./install.sh on the Pi."));
  if (!r.stacks.length) box.append(el("p", { class: "muted" }, "No stacks yet."));
  r.stacks.forEach((s) => box.append(stackCard(s)));
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
  return el("label", { class: meta.type === "checkbox" ? "check" : "block" }, meta.type === "checkbox" ? [input, " " + meta.label] : [meta.label, input]);
}

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
  ["focus-stack default options", "focus_stack", FOCUS_STACK_FIELDS],
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
  $("#btn-af").hidden = !info.has_autofocus;
  $("#sweep-box").hidden = !info.has_autofocus;
  $("#stack-autoprocess-label").hidden = !!info.has_autofocus;  // AF: always auto-stacked
  if (info.lens_range) {
    const [lo, hi] = info.lens_range;
    ["#sweep-start", "#sweep-end"].forEach((s) => { $(s).min = lo; $(s).max = hi; });
  }
  await guarded(loadSettings);
  loadVersion();
  refreshStatus();
  setInterval(refreshStatus, 1500);
  setInterval(pollLens, 2000);
  // Resume watching jobs that were running before a page reload.
  try { (await api("/api/jobs")).jobs.filter((j) => ["queued", "running"].includes(j.status)).forEach((j) => watchJob(j.id)); } catch (_) { /* ignore */ }
})();
