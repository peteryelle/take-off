// netlify/functions/utils/strips.js
// Non-overlapping horizontal strip generation + coordinate dedup
// ─────────────────────────────────────────────────────────────────

import sharp from "sharp";

/**
 * Slice a base64 image into N non-overlapping horizontal strips.
 * Returns array of { index, base64, y_norm_start, y_norm_end, width, height }
 */
export async function makeStrips(base64Image, n = 6) {
  const buffer  = Buffer.from(base64Image, "base64");
  const meta    = await sharp(buffer).metadata();
  const W       = meta.width;
  const H       = meta.height;
  const stripH  = Math.floor(H / n);
  const strips  = [];

  for (let i = 0; i < n; i++) {
    const top    = i * stripH;
    const height = i === n - 1 ? H - top : stripH;   // last strip gets remainder

    const stripBuf = await sharp(buffer)
      .extract({ left: 0, top, width: W, height })
      .jpeg({ quality: 90 })
      .toBuffer();

    strips.push({
      index:       i,
      base64:      stripBuf.toString("base64"),
      y_norm_start: top / H,
      y_norm_end:  (top + height) / H,
      width:       W,
      height,
      full_height: H
    });
  }
  return strips;
}

/**
 * Convert strip-local (x_frac, y_frac_in_strip) to full-image normalized (x, y)
 */
export function toFullCoords(strip, xFrac, yFracInStrip) {
  const fullY = strip.y_norm_start + yFracInStrip * (strip.y_norm_end - strip.y_norm_start);
  return { x: Math.round(xFrac * 1000) / 1000, y: Math.round(fullY * 1000) / 1000 };
}

/**
 * Remove duplicate detections within `threshold` normalized radius.
 * Returns { kept, removed }
 */
export function dedup(detections, threshold = 0.02) {
  const kept    = [];
  const removed = [];
  for (const d of detections) {
    const isDupe = kept.some(k => Math.abs(d.x - k.x) < threshold && Math.abs(d.y - k.y) < threshold);
    isDupe ? removed.push(d) : kept.push(d);
  }
  return { kept, removed };
}

/**
 * Burn numbered red dots onto the master image.
 * Returns base64 JPEG of annotated image.
 */
export async function annotate(base64Image, detections) {
  const buffer = Buffer.from(base64Image, "base64");
  const meta   = await sharp(buffer).metadata();
  const W      = meta.width;
  const H      = meta.height;

  // Build SVG overlay
  const circles = detections.map((d, i) => {
    const cx = Math.round(d.x * W);
    const cy = Math.round(d.y * H);
    const r  = Math.max(14, Math.round(W / 300));
    const fs = Math.max(10, Math.round(W / 420));
    return `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="red" fill-opacity="0.85"/>
      <text x="${cx}" y="${cy + fs / 3}" text-anchor="middle" font-size="${fs}"
            font-family="Arial" font-weight="bold" fill="white">${i + 1}</text>`;
  }).join("");

  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${circles}</svg>`
  );

  const annotated = await sharp(buffer)
    .composite([{ input: svg, blend: "over" }])
    .jpeg({ quality: 88 })
    .toBuffer();

  return annotated.toString("base64");
}

/**
 * Calculate path length in feet from device to demarcation.
 * Returns { path_length_norm, path_length_ft } or nulls if demarc unknown.
 */
export function calcPath(device, demarc, imageW, imageH, scaleIn, scaleFt, dpi = 150) {
  if (demarc?.x == null || demarc?.y == null) return { path_length_norm: null, path_length_ft: null };

  const diag   = Math.sqrt(imageW ** 2 + imageH ** 2);
  const dx     = (device.x - demarc.x) * imageW;
  const dy     = (device.y - demarc.y) * imageH;
  const px     = Math.sqrt(dx ** 2 + dy ** 2);
  const ROUTE  = 1.40;                                    // routing factor

  const norm   = Math.round((px * ROUTE / diag) * 1000) / 1000;
  const ftPerPx = scaleIn > 0 ? (1 / dpi) * (scaleFt / scaleIn) : null;
  const ft     = ftPerPx ? Math.round(px * ROUTE * ftPerPx) : null;

  return { path_length_norm: norm, path_length_ft: ft };
}
