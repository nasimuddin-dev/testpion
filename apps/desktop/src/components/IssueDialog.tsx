import { Copy, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import { copyText } from '../lib/clipboard';
import { Button, EmptyNote, Field, Input, Modal, Textarea } from './ui';

/** From `runs.issue` (issueDraft in core). */
interface IssueDraft {
  title: string;
  body: string;
  url?: string;
  tracker?: string;
}

/**
 * Create issue…: an issue for a failed run, written from what the run kept (the failed steps, their checks with what
 * was expected and what came, the errors; secrets masked). The title and text are yours to change; nothing is sent
 * from here: Copy puts the Markdown on the clipboard, and where the workspace's remote is GitHub, GitLab or Bitbucket
 * a button opens that site's new-issue page with them filled in, for you to read and submit there.
 */
export function IssueDialog() {
  const req = useApp((s) => s.issueFor)!;
  const close = () => useApp.getState().set({ issueFor: undefined });
  const [draft, setDraft] = useState<IssueDraft>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    call<IssueDraft>('runs.issue', { runId: req.runId }).then(
      (d) => {
        if (!live) return;
        setDraft(d);
        setTitle(d.title);
        setBody(d.body);
      },
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [req.runId]);
  const open = async () => {
    // the link is made again from what is in the fields now (the engine cuts a long text for the link and says so in it)
    const link = await call<{ url?: string }>('runs.issueUrl', { title, body });
    if (!link.url) return;
    // the whole text is on the clipboard too: a long one is cut in the link
    await copyText(body, 'the issue text');
    await call('app.openExternal', { url: link.url }).catch(() => window.open(link.url, '_blank', 'noopener'));
  };
  return (
    <Modal
      title="Create issue"
      onClose={close}
      onSubmit={draft?.url ? () => void open() : undefined}
      width={720}
      footer={
        draft ? (
          <>
            <span className="text-xs text-muted mr-auto">Nothing is sent from here. Secrets in the text are masked.</span>
            <Button variant="ghost" icon={<Copy size={13} />} onClick={() => void copyText(`# ${title}\n\n${body}`, 'the issue as Markdown')}>
              Copy as Markdown
            </Button>
            {draft.url && (
              <Button variant="primary" icon={<ExternalLink size={13} />} onClick={() => void open()}>
                Open a new issue on {draft.tracker}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : !draft ? (
        <EmptyNote>Reading the run…</EmptyNote>
      ) : (
        <div data-issue-draft>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Issue title" />
          </Field>
          <Field label="Text (Markdown)">
            <Textarea className="mono text-xs w-full" rows={18} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Issue text" />
          </Field>
          {!draft.url && <p className="text-xs text-muted mt-2">The workspace has no GitHub, GitLab or Bitbucket remote to open a new issue on: copy the text into your issue tracker.</p>}
        </div>
      )}
    </Modal>
  );
}
