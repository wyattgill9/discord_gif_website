// Pure GIF logic. No DOM in here — that's what makes gif.test.js possible.
import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";

// ponytail: 300 frames is the memory ceiling (300 x 480x270 RGBA ~ 155MB).
// Upgrade path: WebCodecs VideoDecoder + a worker if you need long clips.
export const MAX_FRAMES = 300;

// Steps the size ladder walks when output blows the target byte cap.
export const sizeLadder = [
  { fps: 1, scale: 1 },
  { fps: 1, scale: 0.8 },
  { fps: 0.66, scale: 0.8 },
  { fps: 0.66, scale: 0.6 },
  { fps: 0.5, scale: 0.5 },
];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
const atLeast1 = (v) => Math.max(1, Math.round(v));

// Target dimensions. `lock` on: the dimension you typed drives the other via source
// aspect ratio. `lock` off: both are used verbatim, so the image stretches.
export function fitSize(src, { width, height, lock = true } = {}) {
  const aspect = src.width / src.height;
  let w = positive(width);
  let h = positive(height);
  if (lock) {
    if (w) h = w / aspect;
    else if (h) w = h * aspect;
    else ({ width: w, height: h } = src);
  } else {
    w ||= src.width;
    h ||= src.height;
  }
  return { width: atLeast1(w), height: atLeast1(h) };
}

// Timestamps (seconds) to sample a video at. Spread across the whole clip, so hitting
// MAX_FRAMES lowers the effective framerate rather than truncating the video.
export function frameTimes(duration, fps, maxFrames = MAX_FRAMES) {
  if (!(duration > 0)) return [0]; // still image
  const n = Math.min(Math.max(1, Math.round(duration * fps)), maxFrames);
  const step = duration / n;
  return Array.from({ length: n }, (_, i) => i * step);
}

// Drop frames to `factor` of the original count, evenly spaced. Callers must scale the
// frame delay by frames.length / result.length to keep the clip's real-time duration.
export function sampleFrames(frames, factor) {
  if (factor >= 1 || frames.length < 2) return frames;
  const n = Math.max(1, Math.round(frames.length * factor));
  return Array.from({ length: n }, (_, i) =>
    frames[Math.min(frames.length - 1, Math.round((i * frames.length) / n))],
  );
}

// prettier-ignore
const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

// Ordered dithering, in place. gifenc has no dithering of its own, so without this
// photos and video gradients band into visible steps at 256 colors.
// `amount` is the tuning knob: too low does nothing, too high looks like TV static.
export function dither(rgba, width, amount = 16) {
  for (let i = 0, px = 0; i < rgba.length; i += 4, px++) {
    const x = px % width;
    const y = (px / width) | 0;
    const shift = (BAYER8[(y & 7) * 8 + (x & 7)] / 63 - 0.5) * amount;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c] + shift;
      rgba[i + c] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
  return rgba;
}

const hasAlpha = (data) => {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
};

// frames: [{ data: Uint8ClampedArray RGBA, width, height }], delay in ms per frame.
// Async only so it can yield to the event loop — quantizing 300 frames on the main
// thread would otherwise freeze the tab solid with no progress showing.
// ponytail: move this into a Worker if it still feels janky; gifenc is worker-safe.
export async function encode(frames, { delay = 100, dither: useDither = true, onProgress } = {}) {
  if (!frames.length) throw new Error("nothing to encode");

  // ponytail: alpha sniffed from frame 1 only. A clip that fades in from transparent
  // would fool it; no real input does, and scanning every frame costs a full pass each.
  const transparent = hasAlpha(frames[0].data);
  // rgb565 is the better palette, but it has no alpha. Only drop to 4 bits/channel
  // when the source actually needs transparency (PNG emoji, mostly).
  const format = transparent ? "rgba4444" : "rgb565";

  const gif = GIFEncoder();
  let done = 0;
  for (const frame of frames) {
    // Copy before dithering: the caller's frames are cached and reused across
    // size-ladder retries, and dithering an already-dithered frame compounds noise.
    const data = useDither
      ? dither(Uint8ClampedArray.from(frame.data), frame.width)
      : frame.data;

    const palette = quantize(data, 256, { format, oneBitAlpha: transparent });
    const index = applyPalette(data, palette, format);
    // Quantizing can drop the fully-transparent entry; -1 would corrupt the frame,
    // so fall back to writing it opaque.
    const clearIndex = transparent ? palette.findIndex((c) => c[3] === 0) : -1;
    gif.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: Math.round(delay),
      transparent: clearIndex >= 0,
      transparentIndex: Math.max(0, clearIndex),
      // 2 = restore to background, so transparent frames don't ghost the previous one.
      ...(clearIndex >= 0 && frames.length > 1 ? { dispose: 2 } : {}),
    });

    onProgress?.(++done, frames.length);
    if (done % 4 === 0) await new Promise((r) => setTimeout(r)); // let the UI breathe
  }
  gif.finish();
  return gif.bytes();
}
