import { randomBytes } from 'node:crypto';

/**
 * Rendered tp.visualizer pages by id, served on an isolated origin (tpviz:// in the desktop app, /__aps/viz/ behind the
 * web bridge). The newest 30 are kept.
 */
export class VizPages {
  private pages = new Map<string, string>();

  /**
   * Security policy of visualization pages: scripts inline or from well-known CDNs (Chart.js …), no
   * network access (nothing can leave), images and fonts only inline. The page is also sandboxed.
   */
  static readonly CSP =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

  /**
   * Keep a rendered visualization for its isolated page: the template's HTML plus `tp.getData()`
   * (and `pm.getData()` for templates written for Postman). Returns a random id that acts as the
   * page's access key.
   */
  publish(html: string, data: unknown): string {
    const id = randomBytes(16).toString('hex');
    const json = JSON.stringify(data ?? {})
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2230;margin:16px}table{border-collapse:collapse}th,td{border:1px solid #d9dbe3;padding:4px 10px;text-align:left}th{background:#f3f4f8}</style><script>(function(){var d=${json};var api={getData:function(cb){cb(null,d)}};window.pm=api;window.tp=api;})();</script></head><body>${html}</body></html>`;
    this.pages.set(id, page);
    while (this.pages.size > 30) this.pages.delete(this.pages.keys().next().value!);
    return id;
  }

  /** A visualization page (for the host's isolated origin), or undefined. */
  page(id: string): string | undefined {
    return /^[0-9a-f]{32}$/.test(id) ? this.pages.get(id) : undefined;
  }
}
