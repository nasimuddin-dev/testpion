/**
 * Text that fits its box on the flow canvas: every label drawn in a box (a step's name and request line, the compact
 * step's name, a frame's or a lane's title, the Start node) is cut to the box's width, with an ellipsis, measured in
 * the canvas's own units — so it fits at every zoom (the canvas scales boxes and text together; see FlowDiagram's
 * `text-rendering: geometricPrecision`, which keeps text from being hinted to a wider size when zoomed out).
 *
 * Widths are measured once per font and text (a canvas 2D context's measureText, cached); a label is fitted once per
 * text, font and width (cached too).
 */

/** A font as the canvas draws it: size in px, weight, the app's sans or mono family. */
export interface TextFont {
  size: number;
  weight?: number;
  mono?: boolean;
}

type Measure = (text: string, font: TextFont) => number;

const widths = new Map<string, number>();
const fitted = new Map<string, string>();
const LIMIT = 20_000;
let ctx: CanvasRenderingContext2D | null | undefined;
let families: { sans: string; mono: string } | undefined;

function familiesOf(): { sans: string; mono: string } {
  if (families) return families;
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : undefined;
  families = {
    sans: css?.getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif',
    mono: css?.getPropertyValue('--font-mono').trim() || 'monospace',
  };
  return families;
}

/** The CSS font of a TextFont (what the canvas context and the SVG text use). */
export function cssFont(f: TextFont): string {
  const fam = familiesOf();
  return `${f.weight ?? 400} ${f.size}px ${f.mono ? fam.mono : fam.sans}`;
}

/** The width of a text in px at its font, measured once (an estimate without a canvas: tests, a server render). */
export const textWidth: Measure = (text, font) => {
  const key = `${font.size}|${font.weight ?? 400}|${font.mono ? 1 : 0}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) ctx = typeof document !== 'undefined' ? (document.createElement('canvas').getContext('2d') ?? null) : null;
  let w: number;
  if (ctx) {
    ctx.font = cssFont(font);
    w = ctx.measureText(text).width;
  } else w = text.length * font.size * (font.mono ? 0.62 : 0.58);
  if (widths.size > LIMIT) widths.clear();
  widths.set(key, w);
  return w;
};

/**
 * The text cut to `max` px (with … when cut); '' when not even the ellipsis fits. Binary search on the length, so a
 * long URL costs a dozen measures once, then nothing (cached).
 */
export function fitText(text: string, max: number, font: TextFont, measure: Measure = textWidth): string {
  if (!text) return '';
  if (max <= 0) return '';
  const key = `${max}|${font.size}|${font.weight ?? 400}|${font.mono ? 1 : 0}|${text}`;
  const hit = measure === textWidth ? fitted.get(key) : undefined;
  if (hit !== undefined) return hit;
  let out: string;
  if (measure(text, font) <= max) out = text;
  else if (measure('…', font) > max) out = '';
  else {
    let lo = 0;
    let hi = text.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(`${text.slice(0, mid).trimEnd()}…`, font) <= max) lo = mid;
      else hi = mid - 1;
    }
    out = `${text.slice(0, lo).trimEnd()}…`;
  }
  if (measure === textWidth) {
    if (fitted.size > LIMIT) fitted.clear();
    fitted.set(key, out);
  }
  return out;
}

/** Forget the measures (the web fonts finished loading: the widths change). */
export function clearTextFit(): void {
  widths.clear();
  fitted.clear();
  families = undefined;
  ctx = undefined;
}
