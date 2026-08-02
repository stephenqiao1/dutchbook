import { ACCENT, ACCENT_LIGHT, BAD, Canvas, GRID, INK, MUTED, WARN, type RGB } from './png.js';

/**
 * The chart types the report needs, and only those.
 *
 * A grouped/stacked bar chart and a heatmap cover every figure here, which is
 * not a coincidence — every question the report asks is "how does this quantity
 * differ across these buckets", and that is a bar chart. Anything that wanted a
 * scatter or a curve would be a question the sample size cannot answer.
 */

const W = 960;
const H = 540;
const M = { top: 78, right: 34, bottom: 96, left: 96 } as const;

const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

export interface Series {
  readonly label: string;
  readonly values: readonly (number | null)[];
  readonly color: RGB;
}

export interface BarChartSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly yLabel: string;
  readonly labels: readonly string[];
  readonly series: readonly Series[];
  readonly stacked?: boolean;
  /** Printed above each bar group. Same length as `labels`. */
  readonly annotations?: readonly (string | null)[];
  /** A dashed horizontal rule, e.g. an overall median. */
  readonly rule?: { value: number; label: string };
  readonly footnote?: string;
}

/** Chooses a round axis maximum and a matching tick step. */
function niceScale(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 1, step: 0.5 };
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const step = magnitude * factor;
    if (max / step <= 5.5) return { max: Math.ceil(max / step) * step, step };
  }
  return { max: Math.ceil(max / magnitude) * magnitude, step: magnitude };
}

function formatTick(value: number, step: number): string {
  if (step >= 1) return String(Math.round(value));
  const decimals = Math.min(3, Math.max(0, -Math.floor(Math.log10(step))));
  return value.toFixed(decimals);
}

export function barChart(spec: BarChartSpec): Buffer {
  const canvas = new Canvas(W, H);
  const groups = spec.labels.length;

  const stackTotals = spec.labels.map((_, i) =>
    spec.series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0),
  );
  const rawMax = spec.stacked
    ? Math.max(0, ...stackTotals)
    : Math.max(0, ...spec.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = niceScale(Math.max(rawMax, spec.rule?.value ?? 0));

  canvas.text(spec.title, M.left, 22, INK, 3);
  if (spec.subtitle !== undefined) canvas.text(spec.subtitle, M.left, 50, MUTED, 2);

  const yOf = (value: number): number => M.top + PLOT_H - (value / scale.max) * PLOT_H;

  // --- axes and gridlines ---
  for (let tick = 0; tick <= scale.max + 1e-9; tick += scale.step) {
    const y = Math.round(yOf(tick));
    canvas.hLine(M.left, y, PLOT_W, tick === 0 ? MUTED : GRID);
    canvas.text(formatTick(tick, scale.step), M.left - 12, y - 7, MUTED, 2, 'right');
  }
  canvas.vLine(M.left, M.top, PLOT_H, MUTED);
  canvas.textVertical(spec.yLabel, 22, M.top + PLOT_H, MUTED, 2);

  // --- bars ---
  const slot = PLOT_W / Math.max(1, groups);
  const barPad = Math.min(18, slot * 0.18);
  const inner = slot - barPad * 2;
  const perBar = spec.stacked ? inner : inner / Math.max(1, spec.series.length);

  for (let g = 0; g < groups; g += 1) {
    const x0 = M.left + g * slot + barPad;
    let stackTop = M.top + PLOT_H;

    for (const [s, series] of spec.series.entries()) {
      const value = series.values[g];
      if (value === null || value === undefined || value <= 0) continue;

      const height = (value / scale.max) * PLOT_H;
      const x = spec.stacked ? x0 : x0 + s * perBar;
      const y = spec.stacked ? stackTop - height : yOf(value);

      canvas.fillRect(x, y, Math.max(2, perBar - (spec.stacked ? 0 : 3)), height, series.color);
      if (spec.stacked) stackTop -= height;
    }

    // Group label, wrapped onto a second line when it will not fit the slot.
    const label = spec.labels[g] ?? '';
    const cx = M.left + g * slot + slot / 2;
    const fits = canvas.textWidth(label, 2) <= slot - 4;
    canvas.text(label, cx, M.top + PLOT_H + 12, MUTED, fits ? 2 : 1, 'center');

    const note = spec.annotations?.[g];
    if (note !== undefined && note !== null && note !== '') {
      const top = spec.stacked ? stackTop : yOf(Math.max(...spec.series.map((s) => s.values[g] ?? 0)));
      canvas.text(note, cx, top - 16, INK, 2, 'center');
    }
  }

  // --- reference rule ---
  if (spec.rule !== undefined) {
    const y = Math.round(yOf(spec.rule.value));
    canvas.hLine(M.left, y, PLOT_W, BAD, 1, 5);
    // Above the line if there is room, below it otherwise, and always at the
    // left margin where the tallest bars are least likely to be.
    const labelY = y - M.top > 26 ? y - 24 : y + 8;
    canvas.text(spec.rule.label, M.left + 6, labelY, BAD, 2);
  }

  // --- legend ---
  if (spec.series.length > 1) {
    let x = M.left;
    const y = H - 34;
    for (const series of spec.series) {
      canvas.fillRect(x, y, 16, 12, series.color);
      canvas.text(series.label, x + 22, y + 1, MUTED, 2);
      x += 22 + canvas.textWidth(series.label, 2) + 26;
    }
  }

  if (spec.footnote !== undefined) canvas.text(spec.footnote, M.left, H - 16, MUTED, 1);

  return canvas.toPNG();
}

export interface HeatmapSpec {
  readonly title: string;
  readonly subtitle?: string;
  readonly rowLabels: readonly string[];
  readonly colLabels: readonly string[];
  /** `values[row][col]`. Null renders as an empty cell rather than as zero. */
  readonly values: readonly (readonly (number | null)[])[];
  readonly footnote?: string;
}

/**
 * A single-hue heatmap.
 *
 * One hue, varying only in strength, because the quantity is a count with a
 * meaningful zero. A rainbow scale would imply categories where there is a
 * magnitude, and would put a perceptual edge at whatever value happens to land
 * on the green-to-yellow boundary.
 */
export function heatmap(spec: HeatmapSpec): Buffer {
  const rows = spec.rowLabels.length;
  const cols = spec.colLabels.length;
  const canvas = new Canvas(W, 420);

  const left = 108;
  const top = 92;
  const cellW = (W - left - 34) / Math.max(1, cols);
  const cellH = (420 - top - 78) / Math.max(1, rows);

  const flat = spec.values.flat().filter((v): v is number => v !== null);
  const max = Math.max(1, ...flat);

  canvas.text(spec.title, left, 22, INK, 3);
  if (spec.subtitle !== undefined) canvas.text(spec.subtitle, left, 50, MUTED, 2);

  for (let r = 0; r < rows; r += 1) {
    canvas.text(spec.rowLabels[r] ?? '', left - 12, top + r * cellH + cellH / 2 - 7, MUTED, 2, 'right');
    for (let c = 0; c < cols; c += 1) {
      const value = spec.values[r]?.[c] ?? null;
      const x = left + c * cellW;
      const y = top + r * cellH;

      if (value === null) {
        canvas.fillRect(x + 1, y + 1, cellW - 2, cellH - 2, GRID, 0.35);
      } else {
        // Square-rooted so the low end stays distinguishable; counts here are
        // heavily skewed and a linear ramp renders most cells as blank paper.
        const strength = Math.sqrt(value / max);
        canvas.fillRect(x + 1, y + 1, cellW - 2, cellH - 2, ACCENT, 0.08 + 0.92 * strength);
        if (cellW > 42 && value > 0) {
          canvas.text(
            String(value),
            x + cellW / 2,
            y + cellH / 2 - 5,
            strength > 0.55 ? [255, 255, 255] : INK,
            1,
            'center',
          );
        }
      }
    }
  }

  for (let c = 0; c < cols; c += 1) {
    canvas.text(spec.colLabels[c] ?? '', left + c * cellW + cellW / 2, top + rows * cellH + 10, MUTED, 1, 'center');
  }

  // Scale key.
  const keyY = 420 - 44;
  canvas.text('0', left, keyY + 2, MUTED, 1);
  for (let i = 0; i < 120; i += 1) {
    canvas.fillRect(left + 16 + i, keyY, 1, 10, ACCENT, 0.08 + 0.92 * Math.sqrt(i / 119));
  }
  canvas.text(String(max), left + 142, keyY + 2, MUTED, 1);

  if (spec.footnote !== undefined) canvas.text(spec.footnote, left, 420 - 20, MUTED, 1);

  return canvas.toPNG();
}

export const PALETTE = { ACCENT, ACCENT_LIGHT, WARN, BAD, MUTED } as const;
