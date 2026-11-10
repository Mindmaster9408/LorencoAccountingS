/**
 * ============================================================================
 * Slips — image preparation for OCR (sharp)
 * ============================================================================
 * Gives Tesseract a cleaner picture than the raw phone photo:
 *   1. apply EXIF rotation (phones store portrait photos sideways)
 *   2. greyscale
 *   3. crop to the slip — slips are pale paper on a darker table, so we keep
 *      the largest band of rows/columns that are mostly bright
 *   4. scale so the slip is ~1800px wide (Tesseract reads best when text is
 *      roughly 20–40px high; phone photos of narrow slips are often smaller)
 *   5. stretch contrast + light sharpen (faded thermal print)
 *
 * Works on a COPY in memory. The stored original is never touched.
 * ============================================================================
 */

'use strict';

const sharp = require('sharp');

const TARGET_WIDTH = 1800;
const MAX_HEIGHT = 9000; // very long slips: don't blow up memory
const PROBE_WIDTH = 400;

/** Longest run of true values in a boolean array → [start, end] or null. */
function longestRun(flags) {
  let best = null;
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (!best || i - start > best[1] - best[0] + 1) best = [start, i - 1];
      start = -1;
    }
  }
  return best;
}

/** Otsu threshold for an 8-bit greyscale buffer. */
function otsu(pixels) {
  const hist = new Array(256).fill(0);
  for (const p of pixels) hist[p]++;
  const total = pixels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Find the slip's bounding box on a small greyscale probe.
 * Returns {left, top, width, height} in probe pixels, or null when the photo
 * doesn't look like "bright paper on darker background" (then we don't crop).
 */
function findPaperBox(pixels, w, h) {
  const t = otsu(pixels);
  const bright = (x, y) => pixels[y * w + x] > t;
  const rowFlags = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (bright(x, y)) n++;
    rowFlags.push(n / w > 0.25);
  }
  const rows = longestRun(rowFlags);
  if (!rows) return null;
  const colFlags = [];
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = rows[0]; y <= rows[1]; y++) if (bright(x, y)) n++;
    colFlags.push(n / (rows[1] - rows[0] + 1) > 0.5);
  }
  const cols = longestRun(colFlags);
  if (!cols) return null;
  const box = { left: cols[0], top: rows[0], width: cols[1] - cols[0] + 1, height: rows[1] - rows[0] + 1 };
  const area = (box.width * box.height) / (w * h);
  // Too small = probably not the slip; nearly everything = nothing to crop.
  if (area < 0.08 || area > 0.92) return null;
  return box;
}

/**
 * @param {Buffer} buffer  original image (jpeg/png/webp)
 * @returns {Promise<{ clean: Buffer, plain: Buffer, cropped: boolean }>}
 *   clean = cropped/scaled/contrast-stretched PNG; plain = rotated greyscale PNG (fallback pass)
 */
async function prepareForOcr(buffer) {
  // Decode once to raw greyscale pixels; every later step reads this (no re-encoding loss).
  const rotated = await sharp(buffer, { failOn: 'none' }).rotate().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = rotated.info;
  const fromRaw = () => sharp(rotated.data, { raw: { width, height, channels } });

  const probeH = Math.max(1, Math.round(height * (PROBE_WIDTH / width)));
  const probe = await fromRaw().greyscale().resize(PROBE_WIDTH, probeH, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const box = findPaperBox(probe.data, probe.info.width, probe.info.height);

  let img = fromRaw();
  let regionW = width;
  let regionH = height;
  if (box) {
    const sx = width / probe.info.width;
    const sy = height / probe.info.height;
    const pad = 0.02;
    const left = Math.max(0, Math.floor((box.left - box.width * pad) * sx));
    const top = Math.max(0, Math.floor((box.top - box.height * pad) * sy));
    regionW = Math.min(width - left, Math.ceil(box.width * (1 + 2 * pad) * sx));
    regionH = Math.min(height - top, Math.ceil(box.height * (1 + 2 * pad) * sy));
    img = img.extract({ left, top, width: regionW, height: regionH });
  }

  let scale = TARGET_WIDTH / regionW;
  if (regionH * scale > MAX_HEIGHT) scale = MAX_HEIGHT / regionH;
  const clean = await img
    .resize(Math.round(regionW * scale), Math.round(regionH * scale), { kernel: 'lanczos3' })
    .normalise()
    .sharpen({ sigma: 1 })
    .png()
    .toBuffer();

  const plain = await fromRaw().png().toBuffer();
  return { clean, plain, cropped: !!box };
}

module.exports = { prepareForOcr, _test: { findPaperBox, otsu, longestRun } };
