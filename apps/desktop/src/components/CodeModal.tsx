import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { HttpRequestSpec } from '../types';
import { CodeEditor } from './CodeEditor';
import { cx, Modal, Toggle } from './ui';
import { usePersisted } from '../lib/sticky';
import { outputFileName, urlNamePart } from '@testpion/shared';
import { OutputHeader } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

interface Lang {
  id: string;
  label: string;
  syntax: string;
}

/** The file a language's code is saved as (by its editor syntax): extension and menu label. */
const CODE_FILES: Record<string, [string, string]> = {
  shell: ['sh', 'Shell script (.sh)'],
  bat: ['cmd', 'Windows batch file (.cmd)'],
  powershell: ['ps1', 'PowerShell script (.ps1)'],
  javascript: ['js', 'JavaScript file (.js)'],
  python: ['py', 'Python file (.py)'],
  go: ['go', 'Go file (.go)'],
  java: ['java', 'Java file (.java)'],
  kotlin: ['kt', 'Kotlin file (.kt)'],
  dart: ['dart', 'Dart file (.dart)'],
  csharp: ['cs', 'C# file (.cs)'],
  php: ['php', 'PHP file (.php)'],
  ruby: ['rb', 'Ruby file (.rb)'],
  rust: ['rs', 'Rust file (.rs)'],
  swift: ['swift', 'Swift file (.swift)'],
  http: ['http', 'HTTP file (.http)'],
};

/** Postman-style "Code snippet" panel: the request as code in 15 languages/tools. */
export function CodeModal({ request, collectionId, requestId, onClose }: { request: HttpRequestSpec; collectionId?: string; requestId?: string; onClose(): void }) {
  const env = useApp((s) => s.environment);
  const [langs, setLangs] = useState<Lang[]>([]);
  const [lang, setLang] = usePersisted('aps.codeLang', 'curl', { text: true });
  const [reveal, setReveal] = useState(false);
  const [code, setCode] = useState('');
  useEffect(() => {
    void call<Lang[]>('http.codeLanguages').then(setLangs);
  }, []);
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    call<string>('http.code', { request, environment: env, collectionId, requestId, language: lang, revealSecrets: reveal }).then(setCode, (e) => setCode(`// ${asError(e).message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, reveal, requestKey, env, collectionId, requestId]);
  const current = langs.find((l) => l.id === lang);
  // the down arrow (with Copy): the snippet as a file of its language
  const spec = useMemo<OutputSpec>(() => {
    const name = outputFileName({ method: request.method, name: `${urlNamePart(request.url) ?? 'request'}-${lang}`, stamp: false, ext: '' });
    const [ext, label] = CODE_FILES[current?.syntax ?? ''] ?? ['txt', 'Text file (.txt)'];
    return { id: 'code.generated', what: 'code snippet', name, environment: env, empty: code ? undefined : 'Generating the code…', formats: [{ format: 'text', label, fileName: `${name}.${ext}`, build: () => (code.endsWith('\n') ? code : `${code}\n`) }] };
  }, [code, lang, current?.syntax, request.method, request.url, env]);
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
        <div className="flex-1 min-w-0 border border-line rounded-md overflow-hidden flex flex-col" data-output="code.generated">
          <OutputHeader spec={spec} title={current?.label ?? lang} />
          <div className="flex-1 min-h-0">
            <CodeEditor value={code} language={current?.syntax ?? 'plaintext'} readOnly />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted mt-2">Variables and auth are resolved with the current environment. Secret values are shown as &lt;secret&gt; unless you include them.</p>
    </Modal>
  );
}
