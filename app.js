import { MAX_FRAMES, encode, fitSize, frameTimes, sampleFrames, sizeLadder } from "./gif.js";

const $ = (id) => document.getElementById(id);
const KB = 1024;
const MB = 1024 * 1024;
const tick = () => new Promise((r) => setTimeout(r));

// `size` is the longest edge — stretching a 16:9 clip into a square looks awful, and
// Discord scales to fit anyway. `cap` is the byte budget the size ladder aims for.
const PRESETS = [
  { label: "Attachment", note: "480px · 10 MB", size: 480, fps: 15, cap: 10 * MB },
  { label: "Emoji", note: "128px · 256 KB", size: 128, fps: 20, cap: 256 * KB },
  { label: "Sticker", note: "320px · 512 KB", size: 320, fps: 20, cap: 512 * KB },
  { label: "Custom", note: "no size limit", cap: null },
];

let source = null; // { kind, file, width, height, duration, bitmap? , video?, url? }
let preset = PRESETS[0];
let outUrl = null;
let busy = false;

/* ---------- helpers ---------- */

const locked = () => $("lock").getAttribute("aria-pressed") === "true";

const fmt = (b) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.round(b / KB)} KB`);

function setStatus(msg, bad = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("bad", bad);
}

function fail(msg) {
  setStatus(msg, true);
  $("bar").hidden = true;
}

function progress(frac, label) {
  const pct = Math.round(frac * 100);
  $("bar").hidden = false;
  $("bar").firstElementChild.style.width = `${pct}%`;
  setStatus(`${label}… ${pct}%`);
}

// Resolves on `event`, rejects on a media error or if nothing happens at all —
// a silently hung <video> is the single most confusing failure mode here.
function once(el, event, ms = 15000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
    };
    const ok = () => (cleanup(), resolve());
    const bad = () => (cleanup(), reject(new Error(`video stalled waiting for "${event}"`)));
    const timer = setTimeout(bad, ms);
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

// Canvas' one-shot downscale aliases badly past ~2x, and this app downscales hard
// (1920 → 128 for emoji). Halving repeatedly costs almost nothing and looks far better.
const scratch = [document.createElement("canvas"), document.createElement("canvas")];
function drawScaled(ctx, src, sw, sh, dw, dh) {
  let cur = src;
  let cw = sw;
  let ch = sh;
  for (let i = 0; cw > dw * 2 && ch > dh * 2; i++) {
    cw = Math.max(dw, cw >> 1);
    ch = Math.max(dh, ch >> 1);
    const c = scratch[i % 2]; // ping-pong: never read and write the same canvas
    c.width = cw;
    c.height = ch;
    const cx = c.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(cur, 0, 0, cw, ch);
    cur = c;
  }
  ctx.drawImage(cur, 0, 0, dw, dh);
}

/* ---------- loading ---------- */

function reset() {
  $("out").hidden = true;
  $("controls").hidden = true;
  $("preview").removeAttribute("src");
  if (outUrl) URL.revokeObjectURL(outUrl);
  if (source?.url) URL.revokeObjectURL(source.url);
  outUrl = null;
  source = null;
  setStatus("");
}

async function loadImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Your browser couldn't decode that image.");
  });
  return { kind: "image", bitmap, width: bitmap.width, height: bitmap.height, duration: 0 };
}

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  Object.assign(video, { muted: true, playsInline: true, preload: "auto", src: url });
  try {
    await once(video, "loadeddata"); // guarantees dimensions and a decodable first frame
    if (!(video.duration > 0) || !Number.isFinite(video.duration))
      throw new Error("Couldn't read this video's length — try re-exporting it as MP4.");
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err.message?.startsWith("Couldn't")
      ? err
      : new Error("Your browser can't decode this video. Try an MP4 (H.264) or a WebM.");
  }
  return {
    kind: "video",
    video,
    url,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
  };
}

async function load(file) {
  if (busy) return;
  const isVideo = file.type.startsWith("video/");
  if (!isVideo && !file.type.startsWith("image/"))
    return fail(`${file.type || "That file"} is not an image or a video.`);

  reset();
  setStatus(`Reading ${file.name}…`);
  try {
    source = isVideo ? await loadVideo(file) : await loadImage(file);
    source.file = file;
    $("controls").hidden = false;
    $("fpsRow").hidden = source.kind === "image";
    applyPreset();
    await convert();
  } catch (err) {
    fail(err.message);
  }
}

/* ---------- controls ---------- */

function applyPreset() {
  if (!source) return;
  if (preset.fps) $("fps").value = preset.fps;
  if (!preset.size) return;
  $("lock").setAttribute("aria-pressed", "true");
  const long = source.width >= source.height ? { width: preset.size } : { height: preset.size };
  const t = fitSize(source, long);
  $("w").value = t.width;
  $("h").value = t.height;
}

function syncPair(driver) {
  if (!source || !locked() || !$(driver).value) return;
  const t = fitSize(source, driver === "w" ? { width: $("w").value } : { height: $("h").value });
  $(driver === "w" ? "h" : "w").value = driver === "w" ? t.height : t.width;
}

for (const p of PRESETS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = p.label;
  const note = document.createElement("small");
  note.textContent = p.note;
  chip.append(note);
  chip.onclick = () => {
    preset = p;
    for (const c of $("presets").children) c.setAttribute("aria-pressed", String(c === chip));
    applyPreset();
    convert();
  };
  chip.setAttribute("aria-pressed", String(p === preset));
  $("presets").append(chip);
}

$("drop").onclick = () => $("file").click();
$("drop").onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") (e.preventDefault(), $("file").click());
};
$("file").onchange = () => $("file").files[0] && load($("file").files[0]);
$("w").oninput = () => syncPair("w");
$("h").oninput = () => syncPair("h");
$("lock").onclick = () => {
  $("lock").setAttribute("aria-pressed", String(!locked()));
  syncPair("w");
};
$("go").onclick = () => convert();

for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) {
  $("drop").addEventListener(ev, (e) => {
    e.preventDefault();
    $("drop").classList.toggle("over", ev === "dragenter" || ev === "dragover");
  });
}
$("drop").addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files[0];
  if (f) load(f);
});
document.addEventListener("paste", (e) => {
  const f = e.clipboardData?.files[0];
  if (f) load(f);
});

/* ---------- conversion ---------- */

// Decode straight to the target size, once. Retries then work off this cache, so a
// video is never seeked twice.
async function decode(target, times) {
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";

  if (source.kind === "image") {
    drawScaled(ctx, source.bitmap, source.width, source.height, target.width, target.height);
    return [ctx.getImageData(0, 0, target.width, target.height)];
  }

  const out = [];
  for (const [i, t] of times.entries()) {
    // Assigning the position it already holds fires no "seeked" at all, which would
    // hang the very first frame (t=0 on a freshly loaded video) until the timeout.
    if (Math.abs(source.video.currentTime - t) > 1e-6) {
      source.video.currentTime = t;
      await once(source.video, "seeked");
    }
    ctx.clearRect(0, 0, target.width, target.height);
    drawScaled(ctx, source.video, source.width, source.height, target.width, target.height);
    out.push(ctx.getImageData(0, 0, target.width, target.height));
    progress((i + 1) / times.length, "Reading frames");
    await tick();
  }
  return out;
}

function rescale(frames, w, h) {
  const src = document.createElement("canvas");
  const sctx = src.getContext("2d");
  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const dctx = dst.getContext("2d", { willReadFrequently: true });
  dctx.imageSmoothingQuality = "high";
  return frames.map((f) => {
    src.width = f.width;
    src.height = f.height;
    sctx.putImageData(f, 0, 0);
    dctx.clearRect(0, 0, w, h);
    drawScaled(dctx, src, f.width, f.height, w, h);
    return dctx.getImageData(0, 0, w, h);
  });
}

async function convert() {
  if (!source || busy) return;
  busy = true;
  $("go").disabled = true;
  try {
    const target = fitSize(source, {
      width: $("w").value,
      height: $("h").value,
      lock: locked(),
    });
    const fps = Math.min(50, Math.max(1, Number($("fps").value) || 15));
    const useDither = $("dither").checked;

    const times = frameTimes(source.duration, fps, MAX_FRAMES);
    const capped = source.duration * fps > MAX_FRAMES;
    const frames = await decode(target, times);

    // Delay from the real spacing of the frames we captured, not the requested fps —
    // otherwise a clip that hit MAX_FRAMES plays back fast-forwarded.
    const baseDelay = source.duration > 0 ? (source.duration * 1000) / frames.length : 1000 / fps;

    let result;
    for (const [pass, step] of sizeLadder.entries()) {
      const w = Math.max(1, Math.round(target.width * step.scale));
      const h = Math.max(1, Math.round(target.height * step.scale));
      const scaled = step.scale === 1 ? frames : rescale(frames, w, h);
      const picked = sampleFrames(scaled, step.fps);
      const bytes = await encode(picked, {
        delay: (baseDelay * scaled.length) / picked.length,
        dither: useDither,
        onProgress: (d, t) => progress(d / t, pass ? `Shrinking (pass ${pass + 1})` : "Encoding"),
      });
      result = { bytes, width: w, height: h, count: picked.length };
      if (!preset.cap || bytes.length <= preset.cap) break;
    }
    show(result, capped);
  } catch (err) {
    fail(err.message);
  } finally {
    busy = false;
    $("go").disabled = false;
    $("bar").hidden = true;
  }
}

function show(r, capped) {
  const blob = new Blob([r.bytes], { type: "image/gif" });
  if (outUrl) URL.revokeObjectURL(outUrl);
  outUrl = URL.createObjectURL(blob);
  $("preview").src = outUrl;
  $("dl").href = outUrl;
  $("dl").download = `${source.file.name.replace(/\.[^.]*$/, "")}.gif`;

  const bits = [`${r.width}×${r.height}`];
  if (r.count > 1) bits.push(`${r.count} frames`);
  bits.push(fmt(blob.size));
  if (capped) bits.push(`capped at ${MAX_FRAMES} frames`);
  $("info").textContent = `${bits.join(" · ")} `;

  if (preset.cap) {
    const over = blob.size > preset.cap;
    const badge = document.createElement("span");
    badge.className = over ? "warn" : "ok";
    badge.textContent = over
      ? `⚠ ${fmt(blob.size - preset.cap)} over ${fmt(preset.cap)} — shrink it further`
      : `✓ under ${fmt(preset.cap)}`;
    $("info").append(badge);
  }

  $("out").hidden = false;
  setStatus("");
}
