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
  ({ controls: loadControls, stacks: loadStacks, gallery: loadGallery, jobs: loadJobs, settings: loadSettings })[btn.dataset.tab]?.();
}));

// ---------------------------------------------------------------- badges / status
function renderBadges() {
  const b = $("#badges");
  b.replaceChildren();
  if (info.demo) b.append(el("span", { class: "badge warn" }, "DEMO (geen camera)"));
  else if (info.model) b.append(el("span", { class: "badge" }, info.model));
  b.append(el("span", { class: "badge " + (info.focus_stack?.available ? "ok" : "warn"),
    title: info.focus_stack?.binary || "run ./install.sh" },
    info.focus_stack?.available ? "focus-stack ✓" : "focus-stack ontbreekt"));
  b.append(el("span", { class: "badge " + (info.drive ? "ok" : "") },
    info.drive ? (settings.upload?.auto_drive ? "Drive auto-upload" : "Drive ✓") : "Geen Drive"));
  if (info.nas) b.append(el("span", { class: "badge ok" }, "NAS ✓"));
  if (info.has_autofocus) b.append(el("span", { class: "badge" }, "AF"));
  if (status.recording?.active) b.append(el("span", { class: "badge rec" }, "● REC"));
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
  $("#stack-status").textContent = stack
    ? `Stack ${stack.name}: ${stack.count}${stack.total ? "/" + stack.total : ""} frames${stack.sweep ? " (sweep bezig)" : ""}`
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

function uploadNote(r) { return r.uploads && r.uploads.length ? " — upload gestart" : ""; }

$("#btn-photo").addEventListener("click", () => guarded(async () => {
  $("#btn-photo").disabled = true;
  say("Foto nemen…");
  try {
    const r = await api("/api/capture", "POST", { label: label() });
    say(`Opgeslagen: ${r.file} (${r.seconds}s)${uploadNote(r)}`);
  } finally { $("#btn-photo").disabled = false; }
}));

$("#btn-stack-start").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/stack/start", "POST", { label: label() });
  say(`Stack ${r.name} gestart — zet focus en neem frames`);
  refreshStatus();
}));

let frameBusy = false;
async function stackFrame() {
  if (frameBusy) return;
  frameBusy = true;
  try {
    say("Frame nemen…");
    const r = await api("/api/stack/frame", "POST", {});
    say(`Frame ${r.frame}: ${r.file} (${r.seconds}s)`);
  } catch (e) { say(e.message, true); }
  finally { frameBusy = false; refreshStatus(); }
}
$("#btn-stack-frame").addEventListener("click", stackFrame);

$("#btn-stack-end").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/stack/end", "POST", { process: $("#stack-autoprocess").checked });
  say(`Stack ${r.name} afgesloten (${r.frames} frames)` + (r.job ? " — verwerking gestart" : "") + uploadNote(r));
  if (r.job) watchJob(r.job);
  refreshStatus();
}));

$("#btn-video").addEventListener("click", () => guarded(async () => {
  if (status.recording?.active) {
    const r = await api("/api/video/stop", "POST", {});
    say(`Video opgeslagen: ${r.file} (${r.seconds}s)${uploadNote(r)}`);
  } else {
    const r = await api("/api/video/start", "POST", { label: label() });
    say(`Opname gestart: ${r.file}`);
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
  say(`Sweep ${r.name} gestart`);
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
      say(`${job.kind} ${job.name} klaar` + (job.result?.output ? ` → ${job.result.output}` : ""));
      if (job.result?.process_job) watchJob(job.result.process_job);
    } else {
      say(`${job.kind} ${job.name} mislukt: ${job.error}`, true);
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
  if (!r.jobs.length) box.append(el("p", { class: "muted" }, "Nog geen jobs."));
  for (const j of r.jobs) {
    box.append(el("div", { class: "card" },
      el("div", { class: "row" },
        el("strong", {}, `${j.kind}`), el("span", {}, j.name),
        el("span", { class: "badge " + ({ done: "ok", error: "warn", running: "", queued: "" })[j.status] }, j.status),
        (j.status === "running" || j.status === "queued") && j.kind !== "upload"
          ? el("button", { onclick: () => api(`/api/jobs/${j.id}/cancel`, "POST", {}).then(loadJobs) }, "Annuleren") : null,
        el("button", { onclick: async () => {
          const full = await api(`/api/jobs/${j.id}`);
          box.querySelector(`pre[data-id="${j.id}"]`).textContent = full.log.join("\n");
        } }, "Log")),
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
  const reset = el("button", { class: "tiny", title: `standaard: ${JSON.stringify(c.default)}`,
    onclick: () => { if (c.default !== null) { queueControl(c.name, c.default); setTimeout(loadControls, 600); } } }, "↺");
  return el("div", { class: "control", "data-name": c.name.toLowerCase() },
    el("label", { title: `${JSON.stringify(c.min)} … ${JSON.stringify(c.max)}` }, c.name), input, reset);
}

async function loadCameras() {
  const r = await api("/api/cameras");
  $("#camera-select").replaceChildren(...r.cameras.map((c) =>
    el("option", { value: c.index, selected: c.index === r.active },
      `${c.index}: ${c.model}${c.location !== null && c.location !== undefined ? ` (poort ${c.location})` : ""}`)));
}
$("#camera-select").addEventListener("change", (e) => guarded(async () => {
  $("#live").textContent = "Camera wisselen…";
  await api("/api/cameras", "POST", { index: parseInt(e.target.value, 10) });
  location.reload();  // AF/sweep/controls all depend on the camera
}, "#live"));

async function loadControls() {
  loadCameras().catch(() => {});
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
  if (!confirm("Alle camera-controls terugzetten naar standaard?")) return;
  await api("/api/controls", "POST", { reset: true });
  loadControls();
}, "#live"));
$("#btn-af").addEventListener("click", () => guarded(async () => {
  const r = await api("/api/autofocus/trigger", "POST", {});
  $("#live").textContent = `Autofocus ${r.ok ? "gelukt" : "mislukt"} — LensPosition ${r.lens_position}`;
}, "#live"));
setInterval(async () => {
  if ($("#tab-controls").hidden || document.hidden) return;
  try { renderLive((await api("/api/controls")).live); } catch (_) { /* ignore */ }
}, 2000);

// ---------------------------------------------------------------- viewer
function openViewer(title, url, isVideo = false) {
  $("#viewer-title").textContent = title;
  $("#viewer-download").href = url + (url.includes("?") ? "&" : "?") + "download=1";
  $("#viewer-body").replaceChildren(isVideo
    ? el("video", { src: url, controls: true, autoplay: true })
    : el("a", { href: url, target: "_blank" }, el("img", { src: url, alt: title })));
  $("#viewer").showModal();
}
$("#viewer-close").addEventListener("click", () => { $("#viewer").close(); $("#viewer-body").replaceChildren(); });

function uploadButtons(kind, name) {
  const mk = (dest, text) => el("button", { onclick: () => guarded(async () => {
    const r = await api("/api/upload", "POST", { dest, kind, name });
    say(`Upload naar ${dest} gestart`);
    watchJob(r.job);
  }) }, text);
  return [info.drive ? mk("drive", "→ Drive") : null, info.nas ? mk("nas", "→ NAS") : null];
}

function deleteButton(url, what, after) {
  return el("button", { class: "danger", onclick: () => guarded(async () => {
    if (!confirm(`${what} definitief verwijderen?`)) return;
    await api(url, "DELETE");
    after();
  }) }, "Verwijder");
}

// ---------------------------------------------------------------- gallery
async function loadGallery() {
  const [p, v] = await Promise.all([api("/api/photos"), api("/api/videos")]);
  const photos = $("#photos");
  photos.replaceChildren();
  if (!p.photos.length) photos.append(el("p", { class: "muted" }, "Nog geen foto's."));
  for (const f of p.photos) {
    const url = `/media/photos/${enc(f.name)}`;
    photos.append(el("figure", { class: "card" },
      el("img", { src: `/thumb/photos/${enc(f.name)}`, loading: "lazy", alt: f.name,
        onclick: () => openViewer(f.name, url) }),
      el("figcaption", {}, el("div", { class: "small" }, f.name), el("div", { class: "muted small" }, `${f.modified.replace("T", " ")} · ${fmtBytes(f.size)}`)),
      el("div", { class: "row" },
        el("a", { class: "button", href: url + "?download=1" }, "Download"),
        uploadButtons("photo", f.name),
        deleteButton(`/api/photos/${enc(f.name)}`, f.name, loadGallery))));
  }
  const videos = $("#videos");
  videos.replaceChildren();
  if (!v.videos.length) videos.append(el("p", { class: "muted" }, "Nog geen video's."));
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
  const jobInfo = s.job ? el("span", { class: "badge " + ({ done: "ok", error: "warn" })[s.job.status] }, `verwerking: ${s.job.status}`) : null;
  const frames = el("div", { class: "frames", hidden: true },
    s.frames.map((f) => el("figure", {},
      el("img", { src: thumbOf(f), loading: "lazy", alt: f, onclick: () => openViewer(f, base + enc(f)) }),
      el("figcaption", { class: "small" }, f.replace(s.name + "_", "#"),
        s.open ? null : el("button", { class: "tiny danger", title: "Frame verwijderen", onclick: () => guarded(async () => {
          if (!confirm(`Frame ${f} verwijderen?`)) return;
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
          s.outputs.result ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.result, base + enc(s.outputs.result)); } }, "resultaat") : el("span", { class: "muted small" }, "niet verwerkt"),
          s.outputs.depthmap ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); openViewer(s.outputs.depthmap, base + enc(s.outputs.depthmap)); } }, "dieptekaart") : null,
          jobInfo, s.open ? el("span", { class: "badge" }, "open") : null))),
    el("div", { class: "row" },
      processButton(s),
      s.outputs.result && s.frames.length && !s.open ? el("button", { onclick: () => guarded(async () => {
        if (!confirm(`De ${s.frames.length} bronframes van ${s.name} verwijderen? Het resultaat blijft bewaard.`)) return;
        await api(`/api/stacks/${enc(s.name)}/frames`, "DELETE");
        loadStacks();
      }, "#stacks-msg") }, "Bronframes verwijderen") : null,
      s.frames.length ? el("button", { onclick: () => { frames.hidden = !frames.hidden; } }, "Frames") : null,
      el("a", { class: "button", href: `/download/stack/${enc(s.name)}.zip` }, "Download zip"),
      s.outputs.result ? el("a", { class: "button", href: base + enc(s.outputs.result) + "?download=1" }, "Download resultaat") : null,
      s.open ? null : uploadButtons("stack", s.name),
      s.open ? null : deleteButton(`/api/stacks/${enc(s.name)}`, `Stack ${s.name} (alle frames)`, loadStacks)),
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
    say(`Verwerking ${s.name} gestart`);
    watchJob(r.job);
    loadStacks();
  }, "#stacks-msg") }, retry ? "Opnieuw verwerken" : "Process stack");
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
  const box = el("details", { id: "process-options", class: "card" }, el("summary", {}, "focus-stack opties voor deze run"));
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
  if (!info.focus_stack?.available) box.append(el("p", { class: "error" }, "focus-stack binary niet gevonden — voer ./install.sh uit op de Pi."));
  if (!r.stacks.length) box.append(el("p", { class: "muted" }, "Nog geen stacks."));
  r.stacks.forEach((s) => box.append(stackCard(s)));
}
$("#btn-stacks-refresh").addEventListener("click", loadStacks);

// ---------------------------------------------------------------- settings
const FOCUS_STACK_FIELDS = {
  output_format: { label: "Uitvoerformaat", options: ["png", "jpg", "tif"] },
  consistency: { label: "Consistency (0-2)", type: "number" },
  denoise: { label: "Denoise", type: "number", step: "0.1" },
  threads: { label: "Threads", type: "number" },
  batchsize: { label: "Batchsize (0 = alle frames in één batch; Pi 3B: 4 i.v.m. RAM)", type: "number" },
  delete_frames: { label: "Bronframes verwijderen na geslaagde stack", type: "checkbox" },
  jpgquality: { label: "JPG-kwaliteit", type: "number" },
  reference: { label: "Referentieframe (index, leeg = midden)", type: "number" },
  remove_bg: { label: "Remove bg (+ zwart / − wit, leeg = uit)", type: "number" },
  global_align: { label: "Global align", type: "checkbox" },
  full_resolution_align: { label: "Full-resolution align", type: "checkbox" },
  no_whitebalance: { label: "Geen witbalanscorrectie", type: "checkbox" },
  no_contrast: { label: "Geen contrastcorrectie", type: "checkbox" },
  no_transform: { label: "Geen positie-uitlijning", type: "checkbox" },
  no_align: { label: "Uitlijning volledig overslaan", type: "checkbox" },
  align_keep_size: { label: "Originele grootte behouden", type: "checkbox" },
  nocrop: { label: "Niet bijsnijden", type: "checkbox" },
  no_opencl: { label: "Geen OpenCL (Pi: aan)", type: "checkbox" },
  depthmap: { label: "Dieptekaart opslaan", type: "checkbox" },
  view3d: { label: "3D-preview opslaan", type: "checkbox" },
  verbose: { label: "Verbose log", type: "checkbox" },
  extra_args: { label: "Extra argumenten", type: "text" },
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
  ["Bestanden", null, {
    filename_pattern: { label: "Bestandsnaam-patroon ({dt:%Y%m%d_%H%M%S}, {label}, {seq:03d})", type: "text" },
    next_seq: { label: "Volgende {seq}", type: "number" },
    image_format: { label: "Beeldformaat", options: ["png", "tif", "jpg"] },
    png_compress_level: { label: "PNG-compressie (0-9, lossless; lager = sneller)", type: "number" },
    jpeg_quality: { label: "JPG-kwaliteit", type: "number" },
    save_metadata: { label: "Metadata-sidecar (.json) bewaren", type: "checkbox" },
    persist_controls: { label: "Camera-controls onthouden na herstart", type: "checkbox" },
  }],
  ["Upload", "upload", {
    auto_drive: { label: "Automatisch uploaden naar Google Drive (als de rclone-remote bestaat)", type: "checkbox" },
    rclone_remote: { label: "rclone-remote (bv. gdrive:MiniCamera)", type: "text" },
    auto_nas: { label: "Automatisch kopiëren naar NAS", type: "checkbox" },
    nas_path: { label: "NAS-pad (gemount)", type: "text" },
    nas_require_mount: { label: "Weigeren als het NAS-pad niet gemount is", type: "checkbox" },
    stack_frames: { label: "Bij stacks ook alle frames uploaden (anders enkel resultaat)", type: "checkbox" },
  }],
  ["Lens-sweep (AF-camera's)", "sweep", {
    start: { label: "Start LensPosition", type: "number", step: "0.05" },
    end: { label: "Einde LensPosition", type: "number", step: "0.05" },
    steps: { label: "Stappen", type: "number" },
    settle_ms: { label: "Wachttijd per stap (ms)", type: "number" },
  }],
  ["focus-stack standaardopties", "focus_stack", FOCUS_STACK_FIELDS],
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
  form.append(el("p", { class: "muted small" }, `Voorbeeld: ${r.example_name}. Preview-/videoresolutie staan in config.json (herstart nodig).`));
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
  say("Opgeslagen", false, "#settings-message");
  await loadSettings();
  info = await api("/api/camera_info");
  renderBadges();
}, "#settings-message"); });

// ---------------------------------------------------------------- updates
async function loadVersion() {
  try { $("#version").textContent = (await api("/api/version")).version; } catch (_) { /* ignore */ }
}
$("#btn-update-check").addEventListener("click", () => guarded(async () => {
  $("#update-info").textContent = "Controleren…";
  const r = await api("/api/update/check", "POST", {});
  $("#btn-update-apply").hidden = r.behind === 0;
  $("#update-info").replaceChildren(r.behind === 0
    ? "Je hebt de nieuwste versie."
    : el("div", {}, `${r.behind} nieuwe wijziging(en):`, el("pre", { class: "log" }, r.changes.join("\n"))));
}, "#update-info"));
$("#btn-update-apply").addEventListener("click", () => guarded(async () => {
  if (!confirm("Update installeren? De app herstart daarna automatisch.")) return;
  const r = await api("/api/update/apply", "POST", {});
  $("#btn-update-apply").disabled = true;
  const log = el("pre", { class: "log" });
  $("#update-info").replaceChildren("Bezig met updaten…", log);
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
  try { info = await api("/api/camera_info"); } catch (e) { say(e.message, true); }
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
