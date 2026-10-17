import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { AiAction } from './ai/AiAction';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { plural } from '../lib/format';
import { Badge, Empty, Modal } from './ui';

interface SecurityFinding {
  severity: 'high' | 'medium' | 'low';
  where: string;
  message: string;
  requestId?: string;
  category?: 'security' | 'variables';
}

/** Security review of a collection's request definitions (the same lint as `testpion lint`). */
export function SecurityReviewDialog({ collectionId, name, onClose }: { collectionId: string; name: string; onClose(): void }) {
  const [findings, setFindings] = useState<SecurityFinding[]>();
  const env = useApp((s) => s.environment);
  useEffect(() => void call<SecurityFinding[]>('col.securityLint', { id: collectionId, environment: env }).then(setFindings), [collectionId, env]);
  const open = (f: SecurityFinding) => {
    if (!f.requestId) return;
    void openRef({ kind: 'request', collectionId, requestId: f.requestId });
    onClose();
  };
  return (
    <Modal title={`Review · ${name}`} onClose={onClose} width={720}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Checks the requests for secrets typed in instead of kept in secret variables, secrets in query strings, plain http to other hosts and turned-off TLS verification, and for <span className="mono">{'{{variables}}'}</span> that nothing defines{env ? ` in ${env}` : ''} or that are set only by a later request. For responses, add the <b>Security headers</b> check to a request's Tests.
        </p>
        {findings === undefined ? null : findings.length ? (
          <>
            <div className="text-sm flex items-center gap-2">
              <ShieldAlert size={15} className="text-bad" /> {plural(findings.length, 'finding')}
              <AiAction variant="ghost" className="ml-auto" onStart={onClose} label="How to fix (AI)" request={() => ({ task: 'fix-security', title: `Fixes · ${name}`, context: { collection: name, findings: findings.slice(0, 60).map(({ severity, where, message, category }) => ({ severity, category, where, message })) } })} />
            </div>
            <ul className="flex flex-col max-h-[50vh] overflow-auto">
              {findings.map((f, i) => (
                <li key={i}>
                  <button className="w-full text-left flex items-start gap-2 px-2 py-1.5 rounded hover:bg-panel disabled:hover:bg-transparent disabled:cursor-default" disabled={!f.requestId} onClick={() => open(f)} title={f.requestId ? 'Open the request' : undefined}>
                    <Badge tone={f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'default'}>{f.category === 'variables' ? 'variable' : f.severity}</Badge>
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm">{f.message}</span>
                      <span className="text-xs text-muted truncate">{f.where}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty icon={<ShieldCheck size={26} />} title="No findings">
            No typed-in secrets, secrets in URLs, plain http to other hosts or turned-off TLS checks.
          </Empty>
        )}
      </div>
    </Modal>
  );
}
