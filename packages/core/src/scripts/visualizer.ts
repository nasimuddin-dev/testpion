import { renderTemplate } from './sandbox.js';

/** What `tp.visualizer.set(template, data)` left behind, rendered for the Visualize tab. */
export interface VisualizerResult {
  /** The rendered HTML (the renderer still sanitises it and shows it in a sandboxed frame). */
  html?: string;
  error?: string;
}

/** Largest rendered page kept for the UI. */
const MAX_HTML = 2_000_000;

/**
 * Render a Postman Visualizer template (Handlebars) with its data. The template is workspace content (it comes from a
 * script an imported or cloned collection can carry) and Handlebars compiles it to JavaScript, so it is rendered inside the
 * script sandbox (QuickJS: no process, require, files or network), never in the host. Each render has its own context, so
 * templates can't register helpers or partials that leak into later renders. Prototype properties stay blocked
 * (Handlebars' default), and `{{…}}` output is escaped.
 */
export async function renderVisualizer(template: string, data: unknown): Promise<VisualizerResult> {
  const r = await renderTemplate(template, data);
  if (r.html === undefined) return { error: `Visualizer template error: ${r.error ?? 'unknown error'}` };
  const html = r.html;
  return html.length > MAX_HTML ? { html: html.slice(0, MAX_HTML), error: `The visualization was cut to ${MAX_HTML.toLocaleString('en-US')} characters` } : { html };
}
