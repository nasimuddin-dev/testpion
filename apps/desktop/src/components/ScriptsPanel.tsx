import { lazy, Suspense, useState } from 'react';
import { Package, Code2 } from 'lucide-react';
import { SNIPPETS } from '../lib/snippets';
import { CodeEditor } from './CodeEditor';
import { LinkButton, cx } from './ui';

const ScriptPackagesDialog = lazy(() => import('./ScriptPackagesDialog').then((m) => ({ default: m.ScriptPackagesDialog })));

/**
 * Pre-request / Post-response scripts with a snippet list (Postman layout). Scripts use the
 * `tp` script API (Postman-compatible) and run in a WebAssembly sandbox.
 */
export function ScriptsPanel({ pre, post, onPre, onPost }: { pre: string; post: string; onPre(v: string): void; onPost(v: string): void }) {
  const [which, setWhich] = useState<'pre' | 'post'>(() => (pre && !post ? 'pre' : 'post'));
  const [packagesOpen, setPackagesOpen] = useState(false);
  const value = which === 'pre' ? pre : post;
  const set = which === 'pre' ? onPre : onPost;
  const snippets = SNIPPETS.filter((s) => s.kind === 'both' || s.kind === (which === 'pre' ? 'pre' : 'test'));
  return (
    <div className="h-full flex min-h-0">
      <div className="w-40 shrink-0 border-r border-line py-1 text-sm" role="tablist" aria-label="Script">
        {(
          [
            ['pre', 'Pre-request', pre],
            ['post', 'Post-response', post],
          ] as const
        ).map(([id, label, code]) => (
          <button key={id} role="tab" aria-selected={which === id} onClick={() => setWhich(id)} className={cx('w-full text-left px-3 py-1.5 flex items-center gap-2', which === id ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-hover')}>
            {label}
            {code.trim() && <span className="w-1.5 h-1.5 rounded-full bg-ok ml-auto" title="Has a script" />}
          </button>
        ))}
        <button className="w-full text-left px-3 py-1.5 mt-2 flex items-center gap-2 text-muted hover:text-fg hover:bg-hover border-t border-line" title="Shared code that scripts load with tp.require('name')" onClick={() => setPackagesOpen(true)}>
          <Package size={13} /> Packages…
        </button>
        {packagesOpen && (
          <Suspense fallback={null}>
            <ScriptPackagesDialog onClose={() => setPackagesOpen(false)} />
          </Suspense>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="text-xs text-muted px-3 py-1.5 border-b border-line">
          {which === 'pre' ? 'Runs before the request is sent — set variables or change tp.request.' : 'Runs after the response — write tp.test(...) checks and save values with tp.environment.set(...).'} Write{' '}
          <code>tp.*</code> scripts; scripts written for Postman (<code>pm.*</code>) also run unchanged. Scripts run in a sandbox without file or network access.
        </div>
        <div className="flex-1 min-h-0">
          <CodeEditor
            key={which}
            language="javascript"
            value={value}
            onChange={set}
            placeholder={which === 'pre' ? 'tp.variables.set("nonce", tp.uuid());' : 'tp.test("Status code is 200", () => tp.response.to.have.status(200));'}
          />
        </div>
      </div>
      <div className="w-60 shrink-0 border-l border-line flex flex-col min-h-0">
        <div className="px-3 py-1.5 text-xs font-semibold text-muted border-b border-line">Snippets</div>
        <div className="flex-1 overflow-auto py-1">
          {snippets.map((s) => (
            <LinkButton key={s.label} className="w-full text-left px-3 py-1 text-xs" icon={<Code2 size={12} className="shrink-0" />} onClick={() => set((value.trim() ? value.replace(/\s*$/, '\n\n') : '') + s.code + '\n')}>
              {s.label}
            </LinkButton>
          ))}
        </div>
      </div>
    </div>
  );
}
