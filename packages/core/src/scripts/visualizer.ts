import Handlebars from 'handlebars';

/** What `tp.visualizer.set(template, data)` left behind, rendered for the Visualize tab. */
export interface VisualizerResult {
  /** The rendered HTML (the renderer still sanitises it and shows it in a sandboxed frame). */
  html?: string;
  error?: string;
}

/** Largest rendered page kept for the UI. */
const MAX_HTML = 2_000_000;

/**
 * Render a Postman Visualizer template (Handlebars) with its data. Each call uses an isolated
 * Handlebars environment, so templates can't register helpers or partials that leak into later
 * renders. Prototype properties stay blocked (Handlebars' default), and `{{…}}` output is escaped.
 */
export function renderVisualizer(template: string, data: unknown): VisualizerResult {
  try {
    const hb = Handlebars.create();
    // Postman's visualizer offers no helpers beyond Handlebars' built-ins; add a JSON one for debugging
    hb.registerHelper('json', (v: unknown) => JSON.stringify(v, null, 2));
    const html = hb.compile(template, { strict: false })(data ?? {});
    return html.length > MAX_HTML ? { html: html.slice(0, MAX_HTML), error: `The visualization was cut to ${MAX_HTML.toLocaleString('en-US')} characters` } : { html };
  } catch (e) {
    return { error: `Visualizer template error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
