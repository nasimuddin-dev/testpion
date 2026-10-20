/**
 * A chart (the card with its title, plot and legend) as a picture: PNG of the card as it looks, or SVG of its plot.
 * Built in the window from the elements on screen — it is what the person sees, so there is nothing for the backend to
 * add — and handed to the shared save (output.save) as bytes / text. No server round trip, no screenshot of the window.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Properties a standalone picture needs resolved (the app's colours are CSS variables, which a file does not have). */
const PAINT = ['fill', 'stroke', 'stop-color', 'color'] as const;

/** Copy what is drawn for every element of `from` onto the matching element of `to` (inline, so the copy needs no stylesheet). */
function inlineStyles(from: Element, to: Element): void {
  const cs = getComputedStyle(from);
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const name = cs.item(i);
    css += `${name}:${cs.getPropertyValue(name)};`;
  }
  to.setAttribute('style', css);
  const a = from.children;
  const b = to.children;
  for (let i = 0; i < a.length && i < b.length; i++) inlineStyles(a[i]!, b[i]!);
}

/** Remove what is not part of the picture: the card's own download control, tooltips, anything marked. */
function strip(root: Element): void {
  root.querySelectorAll('[data-output-actions], [role="tooltip"], [data-chart-skip]').forEach((n) => n.remove());
}

function size(el: Element): { width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { width: Math.max(1, Math.ceil(r.width)), height: Math.max(1, Math.ceil(r.height)) };
}

/** The card as one SVG document holding the HTML (foreignObject): what the PNG is drawn from. */
function cardSvg(card: HTMLElement): { svg: string; width: number; height: number } {
  const { width, height } = size(card);
  const clone = card.cloneNode(true) as HTMLElement;
  inlineStyles(card, clone);
  strip(clone);
  // the page's background behind the card, so a transparent card is not black in a viewer
  const bg = getComputedStyle(document.body).backgroundColor;
  clone.style.setProperty('background-color', bg);
  clone.style.setProperty('margin', '0');
  const html = new XMLSerializer().serializeToString(clone);
  return {
    svg: `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${html}</foreignObject></svg>`,
    width,
    height,
  };
}

/** The card as PNG bytes (at the screen's pixel ratio, at most 2×). */
export async function chartPng(card: HTMLElement): Promise<Uint8Array> {
  const { svg, width, height } = cardSvg(card);
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const img = new Image();
  img.decoding = 'async';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The chart could not be drawn as a picture'));
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This window cannot draw pictures');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The chart could not be saved as a picture');
  return new Uint8Array(await blob.arrayBuffer());
}

/** The first plot of the card as a standalone SVG (colours resolved, sized, on the page's background), or undefined when it has none. */
export function chartSvg(card: HTMLElement, title: string): string | undefined {
  const plot = card.querySelector('svg');
  if (!plot) return undefined;
  const clone = plot.cloneNode(true) as SVGSVGElement;
  const from = [plot, ...plot.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const t = to[i]!;
    for (const prop of PAINT) {
      const attr = t.getAttribute(prop);
      if (attr && /var\(/.test(attr)) t.setAttribute(prop, cs.getPropertyValue(prop));
    }
    // text drawn with the page's font
    if (t.tagName.toLowerCase() === 'text') {
      t.setAttribute('font-family', cs.fontFamily);
      if (!t.getAttribute('fill')) t.setAttribute('fill', cs.fill !== 'none' ? cs.fill : cs.color);
    }
  });
  const { width, height } = size(plot);
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', getComputedStyle(document.body).backgroundColor);
  clone.insertBefore(bg, clone.firstChild);
  const label = document.createElementNS(SVG_NS, 'title');
  label.textContent = title;
  clone.insertBefore(label, clone.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
}
