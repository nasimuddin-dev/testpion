import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { HttpRequestSpec } from '../types';
import { CodeEditor } from './CodeEditor';
import { Button, cx, Modal, Toggle } from './ui';
import { usePersisted } from '../lib/sticky';
import { useCopied } from '../lib/clipboard';

interface Lang {
  id: string;
  label: string;
  syntax: string;
}

/** Postman-style "Code snippet" panel: the request as code in 15 languages/tools. */
export function CodeModal({ request, collectionId, requestId, onClose }: { request: HttpRequestSpec; collectionId?: string; requestId?: string; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [langs, setLangs] = useState<Lang[]>([]);
  const [lang, setLang] = usePersisted('aps.codeLang', 'curl', { text: true });
  const [reveal, setReveal] = useState(false);
  const [code, setCode] = useState('');
  const { copied, copy } = useCopied();
  useEffect(() => {
    void call<Lang[]>('http.codeLanguages').then(setLangs);
  }, []);
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    call<string>('http.code', { request, environment: env, collectionId, requestId, language: lang, revealSecrets: reveal }).then(setCode, (e) => setCode(`// ${asError(e).message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, reveal, requestKey, env, collectionId, requestId]);
  const current = langs.find((l) => l.id === lang);
  return (
    <Modal
      title="Code snippet"
      onClose={onClose}
      width={980}
      footer={
        <>
          <span className="mr-auto">
            <Toggle checked={reveal} onChange={setReveal} label="Include secret values" />
          </span>
          <Button
            variant="primary"
            icon={copied ? <Check size={13} /> : <Copy size={13} />}
            onClick={() => void copy(code)}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </>
      }
    >
      <div className="flex gap-3 h-[55vh]">
        <div role="listbox" aria-label="Language" className="w-52 shrink-0 overflow-auto border border-line rounded-md py-1">
          {langs.map((l) => (
            <button key={l.id} role="option" aria-selected={l.id === lang} onClick={() => setLang(l.id)} className={cx('w-full text-left px-3 py-1.5 text-sm', l.id === lang ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-hover')}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 border border-line rounded-md overflow-hidden">
          <CodeEditor value={code} language={current?.syntax ?? 'plaintext'} readOnly />
        </div>
      </div>
      <p className="text-xs text-muted mt-2">Variables and auth are resolved with the current environment. Secret values are shown as &lt;secret&gt; unless you include them.</p>
    </Modal>
  );
}
