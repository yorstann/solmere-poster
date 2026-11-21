// The Poster for a Place That Isn't There.
// A single self-contained Node program (standard library only) that draws a
// vintage 1930s railway-poster for SOLMERE, a lagoon town that does not
// exist, and writes it as entry.png into MAKEFUN_OUTPUT_DIR (default
// /output).
//
// Everything is rendered from code: a small rasterizer working on a 2x
// supersampled buffer, an embedded single-stroke (Hershey-style) font for
// the town's name, and a hand-rolled PNG encoder.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Canvas / rasterizer
// ---------------------------------------------------------------------------

const SS = 2; // supersampling factor
const W = 768;
const H = 1024;
const BW = W * SS;
const BH = H * SS;
const buf = new Float32Array(BW * BH * 3);

type RGB = [number, number, number];
const C = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lerpC = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// Deterministic RNG (mulberry32) so the entry is reproducible.
let seed = 0x501e12e;
function rnd(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function blendPx(x: number, y: number, col: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= BW || y >= BH || a <= 0) return;
  const i = (y * BW + x) * 3;
  const ia = 1 - a;
  buf[i] = buf[i] * ia + col[0] * a;
  buf[i + 1] = buf[i + 1] * ia + col[1] * a;
  buf[i + 2] = buf[i + 2] * ia + col[2] * a;
}

// All drawing helpers take final-image coordinates and scale internally.

function fillRect(x: number, y: number, w: number, h: number, col: RGB, a = 1): void {
  const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
  for (let yy = y0; yy < y1; yy++)
    for (let xx = x0; xx < x1; xx++) blendPx(xx, yy, col, a);
}

function disc(cx: number, cy: number, r: number, col: RGB, a = 1): void {
  const R = r * SS;
  const x0 = Math.floor((cx - r) * SS), x1 = Math.ceil((cx + r) * SS);
  const y0 = Math.floor((cy - r) * SS), y1 = Math.ceil((cy + r) * SS);
  const ccx = cx * SS, ccy = cy * SS;
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - ccx, dy = yy - ccy;
      if (dx * dx + dy * dy <= R * R) blendPx(xx, yy, col, a);
    }
}

function line(x1: number, y1: number, x2: number, y2: number, w: number, col: RGB, a = 1): void {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len * SS * 1.6));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(x1 + dx * t, y1 + dy * t, w / 2, col, a);
  }
}

function polyline(pts: Array<[number, number]>, w: number, col: RGB, a = 1, close = false): void {
  for (let i = 0; i + 1 < pts.length; i++) line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, col, a);
  if (close && pts.length > 2) line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], w, col, a);
}

function circleStroke(cx: number, cy: number, r: number, w: number, col: RGB, a = 1, a0 = 0, a1 = Math.PI * 2): void {
  const steps = Math.max(12, Math.ceil(r * SS * 2));
  let prev: [number, number] | null = null;
  for (let s = 0; s <= steps; s++) {
    const t = a0 + ((a1 - a0) * s) / steps;
    const p: [number, number] = [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    if (prev) line(prev[0], prev[1], p[0], p[1], w, col, a);
    prev = p;
  }
}

function ellipseFill(cx: number, cy: number, rx: number, ry: number, col: RGB, a = 1): void {
  const y0 = Math.floor((cy - ry) * SS), y1 = Math.ceil((cy + ry) * SS);
  for (let yy = y0; yy <= y1; yy++) {
    const dy = (yy / SS - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const half = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.round((cx - half) * SS), x1 = Math.round((cx + half) * SS);
    for (let xx = x0; xx <= x1; xx++) blendPx(xx, yy, col, a);
  }
}

function polyFill(pts: Array<[number, number]>, col: RGB, a = 1): void {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const [x, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const y0 = Math.max(0, Math.floor(minY * SS)), y1 = Math.min(BH - 1, Math.ceil(maxY * SS));
  const x0 = Math.max(0, Math.floor(minX * SS)), x1 = Math.min(BW - 1, Math.ceil(maxX * SS));
  for (let yy = y0; yy <= y1; yy++) {
    const py = yy / SS;
    for (let xx = x0; xx <= x1; xx++) {
      const px = xx / SS;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) blendPx(xx, yy, col, a);
    }
  }
}

function rectStroke(x: number, y: number, w: number, h: number, lw: number, col: RGB, a = 1): void {
  line(x, y, x + w, y, lw, col, a);
  line(x + w, y, x + w, y + h, lw, col, a);
  line(x + w, y + h, x, y + h, lw, col, a);
  line(x, y + h, x, y, lw, col, a);
}

// Vertical gradient between y0 and y1 through colour stops [t, colour].
function vgrad(y0: number, y1: number, stops: Array<[number, RGB]>): void {
  for (let y = y0; y < y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0 - 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
    fillRect(0, y, W, 1, lerpC(c0, c1, f));
  }
}

// ---------------------------------------------------------------------------
// Stroke font. Glyph space: baseline y=0, cap height 10. Each glyph:
// [advanceWidth, "stroke|stroke|..."] where a stroke is "x,y" points.
// ---------------------------------------------------------------------------

const F: Record<string, [number, string]> = {
  " ": [5, ""],
  A: [8, "0,0 4,10 8,0|2,3.4 6,3.4"],
  B: [7.5, "0,0 0,10|0,10 4.2,10 6.2,8.6 6.2,6.6 4.2,5.2 0,5.2|4.2,5.2 6.4,3.8 6.4,1.4 4.2,0 0,0"],
  C: [8, "7.6,7.8 5.6,9.8 3.2,10 1.2,8.6 0.5,5.2 1.2,1.8 3.2,0.2 5.6,0.2 7.6,2.2"],
  D: [7.5, "0,0 0,10|0,10 3.8,10 6,8.4 6.8,5 6,1.6 3.8,0 0,0"],
  E: [6.5, "6.5,10 0,10 0,0 6.5,0|0,5.2 4.8,5.2"],
  F: [6, "6,10 0,10 0,0|0,5.2 4.6,5.2"],
  G: [8.5, "7.9,7.8 5.9,9.8 3.4,10 1.3,8.6 0.6,5.2 1.3,1.8 3.4,0.2 5.9,0.2 7.9,1.9 7.9,4.4 5,4.4"],
  H: [7.5, "0,0 0,10|7.5,0 7.5,10|0,5 7.5,5"],
  I: [3, "1.5,0 1.5,10|0.2,10 2.8,10|0.2,0 2.8,0"],
  J: [6, "6,10 6,2.2 4.9,0.3 2.6,0 1.1,1.1 0.8,2.6"],
  K: [7, "0,0 0,10|7,10 0.9,4.4|2,5.4 7,0"],
  L: [6, "0,10 0,0 6,0"],
  M: [9, "0,0 0,10 4.5,3.2 9,10 9,0"],
  N: [7.5, "0,0 0,10 7.5,0 7.5,10"],
  O: [8.5, "3.1,10 1.2,8.7 0.5,5.2 1.2,1.7 3.1,0 5.4,0 7.3,1.7 8,5.2 7.3,8.7 5.4,10 3.1,10"],
  P: [7, "0,0 0,10|0,10 4.6,10 6.7,8.5 6.7,6.3 4.6,4.9 0,4.9"],
  Q: [8.5, "3.1,10 1.2,8.7 0.5,5.2 1.2,1.7 3.1,0 5.4,0 7.3,1.7 8,5.2 7.3,8.7 5.4,10 3.1,10|5.6,2.6 8.6,-0.6"],
  R: [7, "0,0 0,10|0,10 4.6,10 6.7,8.5 6.7,6.3 4.6,4.9 0,4.9|4.6,4.9 7.2,0"],
  S: [7.5, "7.1,8.4 5.3,10 2.9,10 1.1,8.9 1.1,6.9 3.1,5.5 5.4,4.7 6.9,3.3 6.9,1.5 5.1,0 2.6,0 0.9,1.4"],
  T: [7.5, "0,10 7.5,10|3.75,10 3.75,0"],
  U: [7.5, "0,10 0,2.2 1.2,0.4 3.75,0 6.3,0.4 7.5,2.2 7.5,10"],
  V: [8, "0,10 4,0 8,10"],
  W: [10.5, "0,10 2.2,0 5.25,6.8 8.3,0 10.5,10"],
  X: [7.5, "0,0 7.5,10|0,10 7.5,0"],
  Y: [7.5, "0,10 3.75,4.6 7.5,10|3.75,4.6 3.75,0"],
  Z: [7.5, "0,10 7.5,10 0,0 7.5,0"],
};

interface Glyph {
  w: number;
  strokes: Array<Array<[number, number]>>;
}
const GLYPHS: Record<string, Glyph> = {};
for (const [ch, [w, data]] of Object.entries(F)) {
  GLYPHS[ch] = {
    w,
    strokes: data
      ? data.split("|").map((s) => s.split(" ").map((p) => p.split(",").map(Number) as [number, number]))
      : [],
  };
}

interface TextOpt {
  lw?: number; // stroke width as a fraction of cap size
  ls?: number; // extra letter spacing, px
  align?: "left" | "center" | "right";
  alpha?: number;
  bold?: boolean;
}

function charAdvance(ch: string, size: number, o: TextOpt): number {
  const g = GLYPHS[ch] ?? GLYPHS[" "];
  return (g.w + 1.7) * (size / 10) + (o.ls ?? 0);
}

function textWidth(text: string, size: number, o: TextOpt): number {
  let w = 0;
  for (const ch of text) w += charAdvance(ch, size, o);
  return w - (o.ls ?? 0);
}

// Draw text with baseline starting at (x, y).
function drawText(text: string, x: number, y: number, size: number, col: RGB, o: TextOpt = {}): void {
  const scale = size / 10;
  const lw = size * (o.lw ?? 0.115);
  const alpha = o.alpha ?? 1;
  let startX = x;
  if (o.align === "center") startX = x - textWidth(text, size, o) / 2;
  else if (o.align === "right") startX = x - textWidth(text, size, o);
  const passes: Array<[number, number]> = o.bold ? [[0, 0], [lw * 0.38, 0]] : [[0, 0]];
  for (const [ox, oy] of passes) {
    let pen = 0;
    for (const ch of text) {
      const g = GLYPHS[ch] ?? GLYPHS[" "];
      for (const stroke of g.strokes) {
        const pts: Array<[number, number]> = stroke.map(([gx, gy]) => {
          return [startX + pen + gx * scale + ox, y - gy * scale + oy];
        });
        polyline(pts, lw, col, alpha);
      }
      pen += charAdvance(ch, size, o);
    }
  }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const CREAM = C("#F8EFDA");
const SUN_GOLD = C("#F9DE9C");
const HALO = C("#FBE3A1");
const CORAL = C("#E4572E");
const CORAL_DARK = C("#C7431F");
const TOWER_WHITE = C("#F7F2E4");
const ROCK = C("#16323C");
const ROCK_DARK = C("#0E2833");
const HULL = C("#10222B");
const SAIL = C("#F6ECD2");
const SAIL_SHADE = C("#EDDCB4");
const LAMP = C("#FFDF8A");

// ---------------------------------------------------------------------------
// Scene: sky, sun, sea
// ---------------------------------------------------------------------------

const HY = 614; // horizon line (60% of the height)

// Sky: deep teal at the top, warming through peach to soft gold.
vgrad(0, HY + 1, [
  [0, C("#0B4F5C")],
  [0.42, C("#2E7D74")],
  [0.74, C("#F0A868")],
  [1, C("#F8D47E")],
]);

// The low sun, left of centre, just above the horizon, with its halo.
const SUN_X = 296, SUN_Y = 556, SUN_R = 92;
disc(SUN_X, SUN_Y, SUN_R + 38, HALO, 0.1);
circleStroke(SUN_X, SUN_Y, SUN_R + 34, 3, HALO, 0.14);
circleStroke(SUN_X, SUN_Y, SUN_R + 17, 3.5, HALO, 0.3);
disc(SUN_X, SUN_Y, SUN_R, SUN_GOLD, 1);

// Sea: teal at the horizon deepening to blue. Drawn after the sun so the
// disc meets the water cleanly at the horizon line.
vgrad(HY, H, [
  [0, C("#2A8C82")],
  [0.25, C("#146B74")],
  [1, C("#082F4D")],
]);

// The broken golden reflection path under the sun: short horizontal dashes
// of varying width and brightness, widening and fading with depth.
for (let y = HY + 16; y < 905; y += 13) {
  const t = (y - HY) / 290;
  const wdt = (30 + 74 * (1 - t) * (0.55 + rnd() * 0.7)) * (0.8 + rnd() * 0.4);
  const cx = SUN_X + (rnd() * 2 - 1) * 20;
  const a = 0.32 + 0.5 * (1 - t) * (0.6 + rnd() * 0.4);
  fillRect(cx - wdt / 2, y, wdt, 4.5, rnd() > 0.5 ? C("#F6C95E") : SUN_GOLD, Math.min(0.85, a));
}

// ---------------------------------------------------------------------------
// Sailboats: dark hull, cream triangular sails, at different depths.
// ---------------------------------------------------------------------------

function boat(x: number, y: number, s: number): void {
  polyFill(
    [
      [x - 26 * s, y],
      [x + 26 * s, y],
      [x + 17 * s, y + 9 * s],
      [x - 16 * s, y + 9 * s],
    ],
    HULL,
  );
  line(x, y, x, y - 34 * s, 2.2, HULL);
  polyFill(
    [
      [x + 2.5 * s, y - 32 * s],
      [x + 2.5 * s, y - 3 * s],
      [x + 20 * s, y - 3 * s],
    ],
    SAIL,
  );
  polyFill(
    [
      [x - 2.5 * s, y - 29 * s],
      [x - 2.5 * s, y - 3 * s],
      [x - 16 * s, y - 3 * s],
    ],
    SAIL_SHADE,
  );
}

boat(185, 706, 0.9);
boat(522, 798, 1.25);
boat(636, 688, 0.55);

// ---------------------------------------------------------------------------
// The rocky point, lighthouse and houses on the right.
// ---------------------------------------------------------------------------

// The point's top surface, west to east: a clean sloping line the houses
// and the lighthouse base are seated on.
const ROCK_SURFACE: Array<[number, number]> = [
  [522, 600],
  [552, 597],
  [592, 594],
  [642, 590],
  [700, 586],
  [768, 590],
];
function rockTop(x: number): number {
  const s = ROCK_SURFACE;
  if (x <= s[0][0]) return s[0][1];
  for (let i = 0; i + 1 < s.length; i++) {
    const [x0, y0] = s[i];
    const [x1, y1] = s[i + 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return s[s.length - 1][1];
}

polyFill(
  [
    [768, 590],
    [700, 586],
    [642, 590],
    [592, 594],
    [552, 597],
    [522, 600],
    [534, 636],
    [570, 660],
    [650, 676],
    [768, 668],
  ],
  ROCK,
);
ellipseFill(648, 646, 34, 13, ROCK);
polyFill(
  [
    [534, 636],
    [570, 660],
    [650, 676],
    [768, 668],
    [768, 694],
    [596, 688],
    [540, 662],
  ],
  ROCK_DARK,
  0.55,
);

// Houses clustered on the point: flat roofs, cream and terracotta walls,
// each seated with its bottom resting on the rock's surface line and lit
// by one or two tiny lamplit windows.
function house(x: number, w: number, h: number, wall: RGB): void {
  const y = rockTop(x + w / 2) + 2 - h;
  fillRect(x, y, w, h, wall);
  fillRect(x - 2, y - 3, w + 4, 4, C("#5A3A2E"));
  fillRect(x + w * 0.24, y + h * 0.36, 4.5, 5.5, LAMP, 0.95);
  if (w >= 36) fillRect(x + w * 0.62, y + h * 0.36, 4.5, 5.5, LAMP, 0.95);
}
house(536, 38, 24, C("#F3E5C3"));
house(582, 42, 26, C("#D97B4F"));
house(690, 38, 24, C("#F3E5C3"));
house(733, 33, 21, C("#E8D9B0"));

// The lighthouse: a tapered white tower with two coral-red bands, a dark
// gallery, and a warm lit lamp under a coral cap.
const LX = 655;
const towerBase = 592, towerTop = 333;
const halfW = (y: number): number => 16 + ((y - towerTop) / (towerBase - towerTop)) * 8;
function towerBand(y0: number, y1: number, col: RGB): void {
  polyFill(
    [
      [LX - halfW(y1), y1],
      [LX + halfW(y1), y1],
      [LX + halfW(y0), y0],
      [LX - halfW(y0), y0],
    ],
    col,
  );
}
towerBand(527, towerBase, TOWER_WHITE);
towerBand(477, 527, CORAL);
towerBand(405, 477, TOWER_WHITE);
towerBand(358, 405, CORAL);
towerBand(towerTop, 358, TOWER_WHITE);
fillRect(LX - 22, 323, 44, 10, C("#22333A")); // gallery platform
fillRect(LX - 10, 299, 20, 24, C("#22333A")); // lamp room
// The lamp's beam: a translucent pale-gold cone fanning left across the
// sky, drawn before the lamp so the lamp itself sits bright on top of it.
polyFill(
  [
    [LX, 311],
    [180, 251],
    [180, 371],
  ],
  LAMP,
  0.12,
);
disc(LX, 311, 22, LAMP, 0.3); // lamp glow
disc(LX, 311, 6.5, LAMP, 1); // the lit lamp itself
polyFill(
  [
    [LX - 15, 299],
    [LX + 15, 299],
    [LX, 281],
  ],
  CORAL_DARK,
);

// ---------------------------------------------------------------------------
// Finishing: shoreline, palm fronds, birds, the name, the border frame.
// ---------------------------------------------------------------------------

const SILHOUETTE = C("#0C2B33");

// A dark curved shoreline silhouette along the bottom edge.
polyFill(
  [
    [0, 974],
    [110, 959],
    [250, 971],
    [410, 953],
    [560, 967],
    [680, 957],
    [768, 969],
    [768, H],
    [0, H],
  ],
  C("#0A2530"),
);

// Palm fronds reaching in from the top corners: a curved rib (quadratic
// Bezier) with slim leaflets angled off it, all in flat silhouette.
function frond(p0: [number, number], pc: [number, number], p1: [number, number], leafLen: number): void {
  const pt = (t: number): [number, number] => {
    const u = 1 - t;
    return [
      u * u * p0[0] + 2 * u * t * pc[0] + t * t * p1[0],
      u * u * p0[1] + 2 * u * t * pc[1] + t * t * p1[1],
    ];
  };
  const spine: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) spine.push(pt(i / 24));
  polyline(spine, 2.6, SILHOUETTE);
  for (let t = 0.1; t < 1.0; t += 0.055) {
    const p = pt(t);
    const q = pt(Math.min(1, t + 0.02));
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const L = leafLen * (1 - t * 0.5);
    for (const s of [-1, 1]) {
      const a = ang + s * 0.95 + 0.3;
      line(p[0], p[1], p[0] + L * Math.cos(a), p[1] + L * Math.sin(a), 1.9, SILHOUETTE);
    }
  }
}
frond([2, 8], [130, 2], [310, 105], 34);
frond([0, 30], [95, 42], [235, 150], 30);
frond([16, 0], [180, 26], [345, 55], 30);
frond([766, 8], [638, 2], [458, 105], 34);
frond([768, 30], [673, 42], [533, 150], 30);
frond([752, 0], [588, 26], [423, 55], 30);

// A few small birds: simple double-arc strokes in the sky.
function bird(x: number, y: number, s: number): void {
  const col = C("#123B45");
  polyline(
    [
      [x - s, y + 0.32 * s],
      [x - 0.35 * s, y - 0.42 * s],
      [x, y],
    ],
    2.1,
    col,
    0.85,
  );
  polyline(
    [
      [x, y],
      [x + 0.35 * s, y - 0.42 * s],
      [x + s, y + 0.32 * s],
    ],
    2.1,
    col,
    0.85,
  );
}
bird(540, 140, 13);
bird(606, 178, 10);
bird(478, 176, 9);
bird(150, 420, 10);

// The name — the poster's only text — lettered large across the upper
// third in wide-spaced cream capitals at a heavy stroke weight.
drawText("SOLMERE", W / 2, 296, 92, CREAM, { align: "center", ls: 7, lw: 0.15, bold: true });

// A thin cream border frame inset from the edges, like a printed poster.
rectStroke(26, 26, W - 52, H - 52, 3, CREAM);
rectStroke(37, 37, W - 74, H - 74, 1.2, CREAM, 0.75);

// ---------------------------------------------------------------------------
// Downscale + paper grain + PNG encode
// ---------------------------------------------------------------------------

const out = new Uint8Array(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * BW + (x * SS + dx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * W + x) * 3;
    out[o] = Math.max(0, Math.min(255, Math.round(r / n)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(g / n)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(b / n)));
  }
}

// A whisper of paper grain over the finished print: one low-amplitude
// luminance nudge per pixel, shared by all three channels.
for (let p = 0; p < W * H; p++) {
  const nse = Math.round((rnd() * 2 - 1) * 5);
  const o = p * 3;
  out[o] = Math.max(0, Math.min(255, out[o] + nse));
  out[o + 1] = Math.max(0, Math.min(255, out[o + 1] + nse));
  out[o + 2] = Math.max(0, Math.min(255, out[o + 2] + nse));
}

const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  // Per-row adaptive filtering: try every PNG filter for each row and keep
  // the one whose residuals have the smallest absolute sum, so the smooth
  // gradients and the paper grain compress tightly.
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let best: Uint8Array = new Uint8Array(stride);
    let bestScore = Infinity;
    for (const type of [0, 1, 2, 3, 4]) {
      const filt = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (row[i] - pred) & 0xff;
        filt[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best = filt;
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best, y * (stride + 1) + 1);
    prev.set(row);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const png = encodePNG(W, H, out);
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "entry.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
