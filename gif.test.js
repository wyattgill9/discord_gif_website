import { expect, test } from "bun:test";
import { dither, encode, fitSize, frameTimes, sampleFrames } from "./gif.js";

// Synthetic RGBA frame — a horizontal gradient, which is exactly what banding shows up on.
const frame = (w, h, tint = 0, alpha = 255) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    data[i] = ((px % w) / w) * 255;
    data[i + 1] = tint;
    data[i + 2] = 128;
    data[i + 3] = alpha;
  }
  return { data, width: w, height: h };
};

test("encode writes a real GIF", async () => {
  const bytes = await encode([frame(16, 16)], { delay: 100 });
  expect(Array.from(bytes.slice(0, 6))).toEqual([...Buffer.from("GIF89a")]);
  expect(bytes.at(-1)).toBe(0x3b); // trailer
});

test("more frames means more bytes", async () => {
  const one = await encode([frame(16, 16, 0)], { delay: 100 });
  const two = await encode([frame(16, 16, 0), frame(16, 16, 200)], { delay: 100 });
  expect(two.length).toBeGreaterThan(one.length);
});

test("a transparent source still encodes", async () => {
  const bytes = await encode([frame(16, 16, 0, 0)], { delay: 100 });
  expect(Array.from(bytes.slice(0, 6))).toEqual([...Buffer.from("GIF89a")]);
});

test("fitSize keeps aspect when locked", () => {
  expect(fitSize({ width: 1920, height: 1080 }, { width: 480, lock: true })).toEqual({
    width: 480,
    height: 270,
  });
  expect(fitSize({ width: 1920, height: 1080 }, { height: 270, lock: true })).toEqual({
    width: 480,
    height: 270,
  });
});

test("fitSize stretches when unlocked", () => {
  expect(fitSize({ width: 1920, height: 1080 }, { width: 300, height: 100, lock: false })).toEqual({
    width: 300,
    height: 100,
  });
});

test("fitSize falls back to source size and never returns 0", () => {
  expect(fitSize({ width: 640, height: 480 }, {})).toEqual({ width: 640, height: 480 });
  expect(fitSize({ width: 640, height: 480 }, { width: "", height: "", lock: false })).toEqual({
    width: 640,
    height: 480,
  });
  expect(fitSize({ width: 640, height: 480 }, { width: 0.4, lock: false }).width).toBe(1);
});

test("frameTimes samples at fps and caps at maxFrames", () => {
  expect(frameTimes(2, 10, 500)).toHaveLength(20);
  expect(frameTimes(100, 30, 300)).toHaveLength(300);
  expect(frameTimes(0, 15)).toEqual([0]); // still image
  // A capped clip still spans the whole duration instead of truncating.
  expect(frameTimes(100, 30, 300).at(-1)).toBeCloseTo(99.667, 2);
});

test("sampleFrames thins evenly and keeps at least one frame", () => {
  const frames = Array.from({ length: 10 }, (_, i) => i);
  expect(sampleFrames(frames, 0.5)).toEqual([0, 2, 4, 6, 8]);
  expect(sampleFrames(frames, 1)).toBe(frames);
  expect(sampleFrames(frames, 0.01)).toHaveLength(1);
});

test("dither perturbs pixels but stays in range", () => {
  const flat = frame(8, 8, 100);
  const before = Uint8ClampedArray.from(flat.data);
  dither(flat.data, 8);
  expect(flat.data).not.toEqual(before);
  expect(Math.min(...flat.data)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...flat.data)).toBeLessThanOrEqual(255);
  // Alpha must survive untouched, or transparent PNGs get ruined.
  expect(flat.data[3]).toBe(255);
});
