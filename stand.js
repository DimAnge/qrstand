// QR stand geometry: a plate (a drawn figure, a logo outline or a rectangle) carrying a QR code, a logo and text,
// standing in one fixed base that every plate fits. No DOM here: this file runs in the browser and in Node.
import qrcode from './vendor/qrcode.js';
import jsQR from './vendor/jsQR.js';
import { traceMask, simplify, dropSpecks } from './shapes.js';
import { toSTL, rrect } from './core.js';
import { project3mf } from './threemf.js';

// The library keeps only the low byte of each character unless told otherwise: Greek links and WiFi names need UTF-8.
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

export const S = {
  BODY: 4.0, RELIEF: 1.2, SINK: 0.2,            // detail from 4.0 to 5.2 mm; SINK overlaps it into the body
  EDGE: 0.6,                                    // detail stays this far in from the outline
  CUT: 1.5,                                     // the lowest 1.5 mm of a traced shape is cut off so it stands flat
  CLOSE: 10,                                    // background layer: gaps in a traced shape narrower than this are filled with plate
  TAB_W: 60, TAB_H: 8, CLEAR: 0.15,             // tab under every plate, and the slot it plugs into
  FOOT_H: 6,                                    // a plate whose bottom is narrower than the tab gets a foot this tall
  BASE_W: 100, BASE_D: 50, BASE_H: 10, BASE_R: 8, // the base: the same for every plate, slot in the middle
  FRAME_IN: 3,                                  // rectangle frames: this far in from the edge
  TAG_D: 26.6, TAG_FLOOR: 1.6, TAG_DEPTH: 1.4, TAG_WALL: 2,   // NFC pocket for a 25 mm tag up to 1.2 mm thick, 1.6..3.0 mm up
  FIT: 170,                                     // A1 mini bed is 180; parts are kept under this
  QR_QUIET: 2, LABEL_GAP: 1, LABEL_CAP: 4.2,   // plain border round the code, in squares; label top LABEL_GAP under it
  QR_MIN_MODULE: 1.0, NOZZLE: 0.4,              // QR squares at least 2.5 nozzle widths; the scan check prints with NOZZLE
  MIN_FEATURE: 0.6, THIN_AREA: 0.2,             // as in core.js
};
// Height of the first layer printed after each stop (0.20 mm layers).
export const PAUSES = { tag: 3.2, plate: 4.2 };   // tag: the first layer over the NFC pocket

// What each profile fills in. Example links are replaced by the user's own.
export const PROFILES = {
  menu: { label: 'MENU', link: 'https://example.com/menu' },
  reviews: { label: 'LEAVE US\nA REVIEW', link: 'https://example.com/review' },   // two lines: one is 56 mm wide
  wifi: { label: 'WIFI', link: '' },
  custom: { label: '', link: '' },
};

// Ready-made figures, traced like a logo: the drawing, its default width, and in mm at that width the QR code's size,
// its middle across and the top of its plain border. The code hangs from qrTop, so one that must be bigger grows
// downwards (a review link, about 35 characters, needs 29 mm). Scale them all by width / FIGURES[k].width.
// main: trace only the biggest piece (false keeps separate pieces). test.mjs checks each with
// the three profiles gives no warnings. The robot is the user's drawing; its sign's inside is about
// x -22.6..23.3, y 12.7..59.5 at 140 mm.
export const FIGURES = {
  robot: { name: 'Robot', file: 'robot.jpeg', width: 140, qrX: 0.3, qrTop: 58.6, qrSize: 26, main: true },
  wine: { name: 'Wine glass', file: 'shapes/wine.jpeg', width: 78, qrX: 0, qrTop: 154, qrSize: 29, main: false },
  paw: { name: 'Paw', file: 'shapes/paw.jpeg', width: 145, qrX: 0, qrTop: 63, qrSize: 29, main: true },
};

// The text phones read as "join this network". security: 'WPA' (also WPA2/WPA3), 'WEP' or 'nopass'. '' without a name.
const wifiEsc = s => s.replace(/[\\;,:"]/g, c => '\\' + c);
export function wifiText({ name, password = '', security = 'WPA' }) {
  if (!name) return '';
  return security === 'nopass' ? `WIFI:T:nopass;S:${wifiEsc(name)};;` : `WIFI:T:${security};S:${wifiEsc(name)};P:${wifiEsc(password)};;`;
}

// `text` without the letters `font` has no glyph for: textRings would print the font's "missing letter" box instead.
export const printable = (font, text) => [...text].filter(ch => !ch.trim() || font.charToGlyph(ch).index !== 0).join('');

// Squares across the QR code for `text`, or null if it does not fit a QR code.
function modulesOf(text) {
  try { const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make(); return q.getModuleCount(); } catch { return null; }
}
// Smallest code for `text` whose squares print with a 0.4 mm nozzle, in mm (null if it does not fit a QR code).
export const qrMinSize = text => { const n = modulesOf(text); return n && n * S.QR_MIN_MODULE; };
// Half the width of a `size` mm code for `text` with its plain border.
export const qrBorder = (text, size) => size / 2 + S.QR_QUIET * size / modulesOf(text);

// Pixels for polygons (mm, y up, non-zero winding): RGBA, dark inside, white elsewhere. Pixel (0, 0) is the top left
// corner, at (x0, y1); `ppm` pixels per mm.
function rasterize(polys, x0, y1, ppm, w, h) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let j = 0; j < h; j++) {
    const y = y1 - (j + 0.5) / ppm, xs = [];
    for (const r of polys) for (let i = 0, n = r.length; i < n; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % n];
      if ((ay <= y) !== (by <= y)) xs.push([ax + (y - ay) / (by - ay) * (bx - ax), by > ay ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k][1];
      if (!wind) continue;
      const i0 = Math.max(0, Math.round((xs[k][0] - x0) * ppm)), i1 = Math.min(w, Math.round((xs[k + 1][0] - x0) * ppm));
      for (let i = i0; i < i1; i++) px.fill(0, (j * w + i) * 4, (j * w + i) * 4 + 3);
    }
  }
  return px;
}

// Scan check: does the raised code read back as `text` once printed with a 0.4 mm nozzle? Takes the raised detail
// (a CrossSection) inside the code's plain border, drops dark bits narrower than the nozzle and fills light gaps
// narrower than it, draws that at 8 pixels per mm with a white margin and decodes it with jsQR.
export function scanCheck(wasm, relief, text, size, cx, cy) {
  const { CrossSection: CS } = wasm, n = modulesOf(text);
  if (!n) return false;
  const half = qrBorder(text, size), box = rect(CS, cx - half, cy - half, cx + half, cy + half), r = S.NOZZLE / 2;
  let printed = relief.intersect(box);
  printed = grow(grow(grow(grow(printed, -r), r), r), -r).intersect(box);
  const ppm = 8, pad = 2 * size / n, w = Math.ceil((2 * half + 2 * pad) * ppm);
  const res = jsQR(rasterize(printed.toPolygons(), cx - half - pad, cy + half + pad, ppm, w, w), w, w, { inversionAttempts: 'dontInvert' });
  const want = new TextEncoder().encode(text);
  return !!res && res.binaryData.length === want.length && res.binaryData.every((b, i) => b === want[i]);
}

// The QR code for `text` as rings in mm, `size` wide, centred on (cx, cy); null if it does not fit a QR code.
export function qrRings(text, size, cx, cy) {
  let q;
  try { q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make(); } catch { return null; }
  const n = q.getModuleCount(), m = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) m[r * n + c] = q.isDark(r, c) ? 1 : 0;
  const s = size / n;
  const rings = traceMask(m, n, n).map(r => r.map(([x, y]) => [cx + (x - n / 2) * s, cy + (n / 2 - y) * s]));
  return { rings, modules: n, module: s, isDark: (r, c) => q.isDark(r, c) };
}

// ---------- pixels ----------
// Grey pixels (0 dark .. 255 light) -> ink mask. A box blur of `blur` px, three passes (close to a Gaussian),
// smooths the jagged edges of low-resolution logos before the threshold.
export function inkMask(grey, w, h, { threshold = 128, invert = false, blur = 0 } = {}) {
  let a = Float32Array.from(grey);
  const r = Math.round(blur);
  if (r > 0) {
    let b = new Float32Array(a.length);
    const pass = (src, dst, n, m, step, stride) => {          // running mean along rows (step 1) or columns (step w)
      for (let j = 0; j < m; j++) {
        const o = j * stride; let s = 0;
        for (let i = -r; i <= r; i++) s += src[o + Math.min(n - 1, Math.max(0, i)) * step];
        for (let i = 0; i < n; i++) {
          dst[o + i * step] = s / (2 * r + 1);
          s += src[o + Math.min(n - 1, i + r + 1) * step] - src[o + Math.max(0, i - r) * step];
        }
      }
    };
    for (let k = 0; k < 3; k++) { pass(a, b, w, h, 1, w); pass(b, a, h, w, w, 1); }
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = (a[i] < threshold) !== invert ? 1 : 0;
  return mask;
}

// Connected pieces of a mask (4-neighbour): labels and each piece's pixel count and box.
function pieces(mask, w, h) {
  const lab = new Int32Array(w * h), info = [null], stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || lab[s]) continue;
    const id = info.length, p = { n: 0, x0: w, y0: h, x1: 0, y1: 0 }; info.push(p);
    lab[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      p.n++; if (x < p.x0) p.x0 = x; if (x > p.x1) p.x1 = x; if (y < p.y0) p.y0 = y; if (y > p.y1) p.y1 = y;
      for (const j of [x > 0 && i - 1, x < w - 1 && i + 1, y > 0 && i - w, y < h - 1 && i + w])
        if (j !== false && mask[j] && !lab[j]) { lab[j] = id; stack.push(j); }
    }
  }
  return { lab, info };
}

// Only the biggest piece and whatever lies inside its box (drops loose text round a figure).
export function keepMain(mask, w, h) {
  const { lab, info } = pieces(mask, w, h);
  let big = 0; for (let i = 1; i < info.length; i++) if (!big || info[i].n > info[big].n) big = i;
  if (!big) return mask;
  const b = info[big], keep = info.map(p => p && p.x0 >= b.x0 && p.y0 >= b.y0 && p.x1 <= b.x1 && p.y1 <= b.y1);
  return mask.map((_, i) => keep[lab[i]] ? 1 : 0);
}

// Everything the outside cannot reach without crossing ink: the figure with its holes filled.
export function fillHoles(mask, w, h) {
  const out = new Uint8Array(w * h).fill(1), stack = [];
  const visit = i => { if (out[i] && !mask[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) visit(i - 1); if (x < w - 1) visit(i + 1); if (i >= w) visit(i - w); if (i < w * (h - 1)) visit(i + w);
  }
  return out;
}

// Ink mask -> the raised lines and the outline, as pixel rings (y down), plus the outline's pixel box.
// Returns null if there is no ink, or if the trace has more than maxEdges pixel edges.
export function traceFigure(mask, w, h, { mainOnly = true, maxEdges = Infinity } = {}) {
  const ink = mainOnly ? keepMain(mask, w, h) : mask, sil = fillHoles(ink, w, h);
  let x0 = w, x1 = -1, y1 = -1;
  for (let i = 0; i < sil.length; i++) if (sil[i]) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const lines = traceMask(ink, w, h, maxEdges), outline = traceMask(sil, w, h, maxEdges);
  if (!lines || !outline) return null;
  return { lines: simplify(lines, 1), outline: simplify(outline, 1), box: { x0, x1: x1 + 1, foot: y1 + 1 } };
}

// ---------- 2D helpers ----------
const SEG = 32;
const ringArea = r => { let a = 0; for (let i = 0, n = r.length; i < n; i++) a += r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]; return a / 2; };
const rect = (CS, x0, y0, x1, y1) => new CS([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], 'Positive');
const above = (CS, y) => rect(CS, -1000, y, 1000, 1000);
const grow = (cs, d, seg = SEG) => cs.offset(d, 'Round', 2, seg);
const inside = (inner, outer) => inner.subtract(outer).area() < 0.01;
const moved = (rings, x, y) => rings.map(r => r.map(([a, b]) => [a + x, b + y]));
const plus = (a, b) => a ? a.add(b) : b;
const noHoles = (CS, cs) => new CS(cs.toPolygons().filter(c => ringArea(c) > 0), 'Positive');

// Rectangle frames, raised in the detail colour, symmetrical left to right and top to bottom: a line round a rounded
// rectangle FRAME_IN mm in from the edge with four equal corners; 'brackets' is that line at the corners only.
// `t` is the line width in mm; `r` the plate's top corner radius.
function frameOf(CS, style, t, w, h, r) {
  if (!style || style === 'none') return null;
  const c = S.FRAME_IN + t / 2, rc = Math.max(2, r - c), path = [];
  const x0 = -w / 2 + c, x1 = w / 2 - c, y0 = c, y1 = h - c;
  // the four corner arcs, counter-clockwise from the bottom right; the sides are the straight joins between them
  [[x1 - rc, y0 + rc], [x1 - rc, y1 - rc], [x0 + rc, y1 - rc], [x0 + rc, y0 + rc]].forEach(([cx, cy], k) => {
    for (let i = 0; i <= 12; i++) { const a = (k - 1 + i / 12) * Math.PI / 2; path.push([cx + rc * Math.cos(a), cy + rc * Math.sin(a)]); }
  });
  const mid = new CS([path], 'Positive'), line = grow(mid, t / 2).subtract(grow(mid, -t / 2));
  if (style !== 'brackets') return line;
  const L = Math.min(30, Math.max(12, 0.2 * Math.min(w, h)));    // brackets: each arm this long
  const corners = [[-w / 2, 0], [w / 2 - L, 0], [-w / 2, h - L], [w / 2 - L, h - L]].map(([x, y]) => rect(CS, x, y, x + L, y + L));
  return line.intersect(CS.union(corners));
}

// ---------- plate ----------
// The plate above the base (y = 0 is the base top, x = 0 the middle), and the logo lines if it is a traced logo.
// shape: { kind: 'trace', trace: traceFigure() output, width, border, close }
//      | { kind: 'rect', width, height, radius, frame: 'none' | 'line' | 'brackets', frameW (mm) }
// lines: the raised drawing (a trace's lines, a rectangle's frame), or null.
// A traced shape gets a background layer: its outline grown by `border`, with gaps narrower than `close` mm that
// open to the outside (between an arm and the body, say) filled in, so they print as plain plate.
// That is a closing: grow by border + close / 2, then shrink back by close / 2.
export function plateShape(wasm, shape) {
  const { CrossSection: CS } = wasm;
  if (shape.kind === 'trace') {
    const t = shape.trace, s = shape.width / (t.box.x1 - t.box.x0), cx = (t.box.x0 + t.box.x1) / 2;
    const mm = rings => rings.map(r => r.map(([x, y]) => [(x - cx) * s, (t.box.foot - y) * s - S.CUT]));
    const r = (shape.close ?? S.CLOSE) / 2, sil = new CS(mm(t.outline), 'EvenOdd');
    let outline = r > 0 ? grow(grow(sil, shape.border + r), -r) : grow(sil, shape.border);
    outline = noHoles(CS, outline).intersect(above(CS, 0));   // no holes left by the closing (between a paw's toes)
    return { outline, lines: new CS(dropSpecks(mm(t.lines), S.MIN_FEATURE / 2), 'EvenOdd') };
  }
  const w = shape.width, h = shape.height;
  const r = Math.min(shape.radius, w / 2, h / 2);   // a rectangle; square bottom corners: it sits flush on the base
  const outline = new CS([rrect(-w / 2, 0, w / 2, h, [0, 0, r, r])], 'Positive');
  return { outline, lines: frameOf(CS, shape.frame, shape.frameW ?? 2, w, h, r) };
}

// o: { shape (see plateShape), qr: { text, size, x, y, label, labelAt } | null (no code), logo: { rings, x, y } | null, texts: [{ rings, x, y }],
//   nfc: { x, y } | null (the middle of a hidden pocket for an NFC tag) }
//   rings (label, logo, texts) in mm, y up, centred on (0, 0); x, y in mm from the middle and up from the base top.
//   The label goes under the code, or centred on labelAt ({ x, y }) if given. The logo item is for rectangles; a traced
//   shape brings its own lines.
// Returns { mesh, stl, errors, warnings, width, height (with the tab), hasRelief, hasTag, tab: { x, w }, scan (the code reads back
//   as printed; null without a code), label: { x, y, half: [w / 2, h / 2] } | null, draw: { outline, relief, thin } }.
export function buildPlate(wasm, o) {
  const { CrossSection: CS } = wasm;
  const errors = [], warnings = [];
  let { outline, lines } = plateShape(wasm, o.shape);
  // tab: the same for every plate (the base is), under the middle of the flat bottom; a bottom narrower than the
  // tab gets a foot with rounded top corners
  const floorCS = outline.intersect(rect(CS, -1000, 0, 1000, 1));
  if (floorCS.isEmpty()) throw new Error('plate has no bottom');
  const floor = floorCS.bounds(), tabX = (floor.min[0] + floor.max[0]) / 2, tabW = S.TAB_W;
  if (floor.max[0] - floor.min[0] < tabW + 4)
    outline = outline.add(new CS([rrect(tabX - tabW / 2 - 4, 0, tabX + tabW / 2 + 4, S.FOOT_H, [0, 0, 3, 3])], 'Positive'));
  outline = noHoles(CS, outline.add(rect(CS, tabX - tabW / 2, -S.TAB_H, tabX + tabW / 2, 0.5)));   // no gap left over a dip in the bottom
  const b = outline.bounds(), W = b.max[0] - b.min[0], H = b.max[1] - b.min[1];
  if (W > S.FIT || H > S.FIT) errors.push(`The plate is ${W.toFixed(0)} × ${H.toFixed(0)} mm; it must stay under ${S.FIT} mm to fit the bed. Make it smaller.`);

  const room = grow(outline, -S.EDGE).intersect(above(CS, 0.5));
  // the NFC pocket: inside the plate with TAG_WALL to spare, above the base; it may sit behind the code or text
  const pocket = o.nfc ? CS.circle(S.TAG_D / 2, 64).translate([o.nfc.x, o.nfc.y]) : null;
  if (pocket && !inside(grow(pocket, S.TAG_WALL), outline.intersect(above(CS, 0))))
    errors.push(`The NFC tag does not fit there: it needs ${S.TAG_WALL} mm of plate all round it, above the base. Drag the circle further in.`);
  // the drawing without slivers a 0.4 mm nozzle cannot print (where the flat bottom cuts through a line, say)
  let relief = lines ? grow(grow(lines.intersect(room), -S.MIN_FEATURE / 2, 16), S.MIN_FEATURE / 2, 16) : null;
  const extra = [];
  if (o.logo?.rings.length) extra.push(['logo', new CS(moved(o.logo.rings, o.logo.x, o.logo.y), 'EvenOdd')]);
  for (const t of o.texts || []) if (t.rings.length) extra.push(['text', new CS(moved(t.rings, t.x, t.y), 'NonZero')]);
  const q = o.qr?.text ? qrRings(o.qr.text, o.qr.size, o.qr.x, o.qr.y) : null;
  let code = null, clear = null, label = null;
  if (!o.qr) { /* a plate without a code: logo and texts only */ }
  else if (!q) errors.push(o.qr.text ? 'This is too long for a QR code. Use a shorter link.' : 'Type what the QR code should hold: a link, or the WiFi name.');
  else {
    const half = o.qr.size / 2 + S.QR_QUIET * q.module;
    clear = rect(CS, o.qr.x - half, o.qr.y - half, o.qr.x + half, o.qr.y + half);
    if (!inside(clear, room)) errors.push('The QR code (with the plain border it needs) does not fit inside the plate there. Drag it further in or make it smaller.');
    if (q.module < S.QR_MIN_MODULE - 1e-9)
      errors.push(`The QR squares are ${q.module.toFixed(2)} mm; with a 0.4 mm nozzle they must be at least ${S.QR_MIN_MODULE} mm. Make the code at least ${qrMinSize(o.qr.text)} mm, or the link shorter.`);
    // squares touching only at a corner would share an edge: the -0.01 mm mitre parts them (see core.js)
    code = new CS(q.rings, 'EvenOdd').offset(-0.01, 'Miter').intersect(room);
    if (o.qr.label?.length) {                   // its top LABEL_GAP under the border, whatever its height (one line or two)
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const r of o.qr.label) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const at = o.qr.labelAt ?? { x: o.qr.x, y: o.qr.y - half - S.LABEL_GAP - y1 };
      label = { x: at.x, y: at.y, half: [(x1 - x0) / 2, (y1 - y0) / 2] };
      extra.push(['text under the QR code', new CS(moved(o.qr.label, at.x, at.y), 'NonZero')]);
    }
  }
  for (const [name, e] of extra) {
    if (!inside(e, room)) warnings.push(`Part of the ${name} is outside the plate and was cut off. Move it or make it smaller.`);
    if (lines && lines.intersect(e).area() > 1)      // merged with the drawing's lines it cannot be read
      warnings.push(`The ${name} runs into the ${o.shape.kind === 'rect' ? 'frame' : 'drawing'}. Drag it to a plain part of the plate.`);
    relief = plus(relief, e.intersect(room));
  }
  if (relief && clear && !relief.intersect(clear).isEmpty()) {
    warnings.push('What was under the QR code (logo, text or frame) was cleared away round it so the code scans. Drag them apart to keep all of it.');
    relief = relief.subtract(clear);
  }
  if (code) relief = plus(relief, code);
  if (relief) relief = relief.simplify(0.02);
  outline = outline.simplify(0.02);             // no near-duplicate points, or the STL is not a closed solid
  // only a code that is otherwise fine is worth reading back
  const scan = !o.qr ? null : !!code && !errors.length && scanCheck(wasm, relief, o.qr.text, o.qr.size, o.qr.x, o.qr.y);
  if (code && !errors.length && !scan) errors.push('The scan check could not read the code as a 0.4 mm nozzle would print it. Make the code bigger.');

  // thin details, as core.js finds them: what an opening by half the minimum width removes, minus corner tips
  const r = S.MIN_FEATURE / 2, g = (cs, d) => grow(cs, d, 16);
  const thinRings = !relief || relief.isEmpty() ? [] : g(g(relief.subtract(g(g(relief, -r), r)), -0.01), 0.01).toPolygons().filter(c => { const a = ringArea(c); return a < 0 || a >= S.THIN_AREA; });
  const thin = thinRings.length ? new CS(thinRings, 'Positive') : null;
  if (thin && !thin.isEmpty()) warnings.push(`Details shown in red are thinner than ${S.MIN_FEATURE} mm and may not print with a 0.4 mm nozzle.`);

  const hasRelief = !!relief && !relief.isEmpty();
  let solid = outline.extrude(S.BODY);
  if (hasRelief) solid = solid.add(relief.extrude(S.RELIEF + S.SINK).translate([0, 0, S.BODY - S.SINK]));
  if (pocket) solid = solid.subtract(pocket.extrude(S.TAG_DEPTH).translate([0, 0, S.TAG_FLOOR]));
  const m = solid.getMesh(), mesh = { positions: m.vertProperties, indices: m.triVerts };
  return {
    mesh, stl: toSTL(mesh), errors, warnings, width: W, height: H, hasRelief, hasTag: !!pocket, tab: { x: tabX, w: tabW }, scan, label,
    draw: { outline: outline.toPolygons(), relief: hasRelief ? relief.toPolygons() : [], thin: thin && !thin.isEmpty() ? thin.toPolygons() : [] },
  };
}

// ---------- base ----------
// One base for every plate: BASE_W x BASE_D x BASE_H, one colour, a slot in the middle for the TAB_W tab.
// Returns { mesh, stl }.
export function buildBase(wasm) {
  const { Manifold, CrossSection: CS } = wasm, R = S.BASE_R, W = S.BASE_W, D = S.BASE_D;
  const foot = grow(rect(CS, R - W / 2, R - D / 2, W / 2 - R, D / 2 - R), R, 64);
  let solid = Manifold.union([
    grow(foot, -1).extrude(1), foot.extrude(S.BASE_H - 2).translate([0, 0, 1]), grow(foot, -1).extrude(1).translate([0, 0, S.BASE_H - 1]),
  ]);                                             // 1 mm steps round the top and bottom edges
  const c = S.CLEAR;
  solid = solid.subtract(Manifold.cube([S.TAB_W + 2 * c, S.BODY + 2 * c, S.TAB_H + 1], true).translate([0, 0, S.BASE_H - S.TAB_H / 2 + 0.5]));
  const m = solid.getMesh(), mesh = { positions: m.vertProperties, indices: m.triVerts };
  return { mesh, stl: toSTL(mesh) };
}

// Bambu Studio project with the plate, or the base when `plate` is the base (one colour, no stop). kind 'pause'
// stops for a manual filament change (no AMS); 'colour' switches to filament 2 (AMS). Nothing raised, no event.
// A plate with an NFC pocket also stops (both kinds) to drop the tag in.
export function project(settings, part, kind, deflate, name = 'plate') {
  const events = [...part.hasTag ? [{ z: PAUSES.tag, kind: 'pause' }] : [], ...part.hasRelief ? [{ z: PAUSES.plate, kind }] : []];
  return project3mf({ settings, deflate, objects: [{ name, mesh: part.mesh, plate: 0, cx: 90, cy: 90 }], plates: [{ events }] });
}
