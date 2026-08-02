import { crc32, deflateSync } from 'node:zlib';

/**
 * A small raster canvas that writes PNG, with no dependencies.
 *
 * The alternative was a headless browser or a native image library, and both
 * are worse here for the same reason: the acceptance criterion is that the
 * report runs from a clean checkout, and a chart that needs Chrome installed or
 * a binary that fails to build is a chart nobody can regenerate. Everything
 * below is Node's own `zlib` plus arithmetic.
 *
 * The charts this has to draw are bar charts, histograms and a heatmap — all
 * axis-aligned rectangles and straight lines. That is why there is no
 * antialiasing and no curve support: they would be a lot of code for output
 * that is not needed, and crisp edges suit a chart better anyway.
 */

export type RGB = readonly [number, number, number];

export const INK: RGB = [26, 26, 24];
export const MUTED: RGB = [128, 128, 122];
export const GRID: RGB = [226, 226, 220];
export const PAPER: RGB = [255, 255, 255];
export const ACCENT: RGB = [47, 93, 80];
export const ACCENT_LIGHT: RGB = [142, 184, 168];
export const WARN: RGB = [169, 121, 29];
export const BAD: RGB = [168, 50, 31];

/**
 * A 5x7 bitmap font, one byte per column, bit 0 the top row.
 *
 * Lowercase is folded to uppercase rather than given its own 26 glyphs. Chart
 * labels are short and read fine in caps, and every glyph here is a place a
 * typo hides silently — the render tests exist because of exactly that.
 */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
  '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  '.': [0x00, 0x00, 0x60, 0x00, 0x00],
  ',': [0x00, 0x40, 0x60, 0x00, 0x00],
  ':': [0x00, 0x00, 0x36, 0x00, 0x00],
  ';': [0x00, 0x56, 0x36, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
  '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  '%': [0x23, 0x13, 0x08, 0x64, 0x62],
  '(': [0x00, 0x1c, 0x22, 0x41, 0x00],
  ')': [0x00, 0x41, 0x22, 0x1c, 0x00],
  '<': [0x08, 0x14, 0x22, 0x41, 0x00],
  '>': [0x00, 0x41, 0x22, 0x14, 0x08],
  '=': [0x14, 0x14, 0x14, 0x14, 0x14],
  '?': [0x02, 0x01, 0x51, 0x09, 0x06],
  '!': [0x00, 0x00, 0x5f, 0x00, 0x00],
  '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
  $: [0x24, 0x2a, 0x7f, 0x2a, 0x12],
  '*': [0x14, 0x08, 0x3e, 0x08, 0x14],
  _: [0x40, 0x40, 0x40, 0x40, 0x40],
  '|': [0x00, 0x00, 0x7f, 0x00, 0x00],
  "'": [0x00, 0x05, 0x03, 0x00, 0x00],
  '"': [0x00, 0x07, 0x00, 0x07, 0x00],
  '~': [0x08, 0x04, 0x08, 0x10, 0x08],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
/** Blank columns between characters, in font pixels. */
const TRACKING = 1;

export type Align = 'left' | 'center' | 'right';

export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly #pixels: Uint8Array;

  constructor(width: number, height: number, background: RGB = PAPER) {
    this.width = Math.max(1, Math.trunc(width));
    this.height = Math.max(1, Math.trunc(height));
    // RGB only. An alpha channel would double the file for charts that are
    // always drawn on an opaque background.
    this.#pixels = new Uint8Array(this.width * this.height * 3);
    this.fillRect(0, 0, this.width, this.height, background);
  }

  /** Blends `color` over the existing pixel. `alpha` is 0..1. */
  set(x: number, y: number, color: RGB, alpha = 1): void {
    const px = Math.trunc(x);
    const py = Math.trunc(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    if (alpha <= 0) return;

    const i = (py * this.width + px) * 3;
    if (alpha >= 1) {
      this.#pixels[i] = color[0];
      this.#pixels[i + 1] = color[1];
      this.#pixels[i + 2] = color[2];
      return;
    }
    for (let c = 0; c < 3; c += 1) {
      const under = this.#pixels[i + c] ?? 0;
      this.#pixels[i + c] = Math.round(under + (color[c]! - under) * alpha);
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: RGB, alpha = 1): void {
    const x0 = Math.trunc(x);
    const y0 = Math.trunc(y);
    const x1 = Math.trunc(x + w);
    const y1 = Math.trunc(y + h);
    for (let py = Math.min(y0, y1); py < Math.max(y0, y1); py += 1) {
      for (let px = Math.min(x0, x1); px < Math.max(x0, x1); px += 1) {
        this.set(px, py, color, alpha);
      }
    }
  }

  hLine(x: number, y: number, w: number, color: RGB, alpha = 1, dash = 0): void {
    for (let i = 0; i < w; i += 1) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue;
      this.set(x + i, y, color, alpha);
    }
  }

  vLine(x: number, y: number, h: number, color: RGB, alpha = 1, dash = 0): void {
    for (let i = 0; i < h; i += 1) {
      if (dash > 0 && Math.floor(i / dash) % 2 === 1) continue;
      this.set(x, y + i, color, alpha);
    }
  }

  /** Width of `text` in device pixels at `scale`. */
  textWidth(text: string, scale = 2): number {
    const chars = [...text].length;
    if (chars === 0) return 0;
    return (chars * (GLYPH_WIDTH + TRACKING) - TRACKING) * scale;
  }

  static readonly lineHeight = GLYPH_HEIGHT;

  /**
   * Draws `text` with its top-left at (x, y), or centred/right-aligned on x.
   *
   * Characters with no glyph are skipped rather than substituted. A missing
   * glyph in a chart label should look like a gap, not like a different
   * character that happens to be wrong.
   */
  text(text: string, x: number, y: number, color: RGB, scale = 2, align: Align = 'left'): void {
    const upper = text.toUpperCase();
    const width = this.textWidth(upper, scale);
    const startX = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;

    let cursor = startX;
    for (const char of upper) {
      const glyph = GLYPHS[char];
      if (glyph !== undefined) {
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          const bits = glyph[col] ?? 0;
          for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
            if ((bits & (1 << row)) === 0) continue;
            this.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cursor += (GLYPH_WIDTH + TRACKING) * scale;
    }
  }

  /** Text rotated a quarter turn anticlockwise, for a y-axis title. */
  textVertical(text: string, x: number, y: number, color: RGB, scale = 2): void {
    const upper = text.toUpperCase();
    let cursor = y;
    for (const char of upper) {
      const glyph = GLYPHS[char];
      if (glyph !== undefined) {
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          const bits = glyph[col] ?? 0;
          for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
            if ((bits & (1 << row)) === 0) continue;
            // (col, row) -> (row, -col): a quarter turn anticlockwise.
            this.fillRect(x + row * scale, cursor - col * scale, scale, scale, color);
          }
        }
      }
      cursor -= (GLYPH_WIDTH + TRACKING) * scale;
    }
  }

  /**
   * Encodes to PNG: 8-bit RGB, no interlacing, filter type 0 on every scanline.
   *
   * Per-scanline filtering would compress better, but a chart is mostly flat
   * colour and deflate already handles that; the files come out a few tens of
   * kilobytes either way.
   */
  toPNG(): Buffer {
    const stride = this.width * 3;
    const raw = Buffer.allocUnsafe((stride + 1) * this.height);

    for (let y = 0; y < this.height; y += 1) {
      raw[y * (stride + 1)] = 0;
      Buffer.from(this.#pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type 2 = truecolour RGB
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  // The CRC covers the type and the data, but not the length.
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
