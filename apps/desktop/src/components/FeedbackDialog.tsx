import { Bug, Copy, Download, ExternalLink, HelpCircle, Lightbulb, Mail, Paintbrush } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { call } from '../api';
import { finishSave, type SaveResult } from '../lib/files';
import { toastError, useApp } from '../store';
import { LinkButton, Button, cx, Field, Input, Modal, Toggle } from './ui';

export type FeedbackKind = 'bug' | 'idea' | 'ui' | 'question';

/** What opens the dialog: a kind, a title and text to start from (e.g. the error of a view that crashed). */
export interface FeedbackRequest {
  kind?: FeedbackKind;
  title?: string;
  description?: string;
  where?: string;
  /** An error to include (a crash): it is added to the recent errors. */
  error?: string;
}

interface Context {
  diagnostics: string[];
  errors: string[];
}
interface Report {
  title: string;
  body: string;
  url: string;
  shortened: boolean;
  mailto: string;
  mailShortened: boolean;
}

const KINDS: Array<{ id: FeedbackKind; label: string; hint: string; icon: ReactNode }> = [
  { id: 'bug', label: 'Problem', hint: 'Something is broken or wrong', icon: <Bug size={16} /> },
  { id: 'idea', label: 'Idea', hint: 'A feature or a better way to work', icon: <Lightbulb size={16} /> },
  { id: 'ui', label: 'Design', hint: 'Layout, wording, something hard to use', icon: <Paintbrush size={16} /> },
  { id: 'question', label: 'Question', hint: 'How do I …?', icon: <HelpCircle size={16} /> },
];

/**
 * Help ▸ Send feedback: report a problem, suggest an idea or say what is hard to use. The user sees the whole report
 * before anything leaves the machine: it opens as a pre-filled GitHub issue they post themselves, or is copied or
 * saved. Versions and recent errors are added only when ticked (paths and secrets masked).
 */
export function FeedbackDialog({ request, onClose }: { request: FeedbackRequest; onClose(): void }) {
  const view = useApp((s) => s.view);
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? 'idea');
  const [title, setTitle] = useState(request.title ?? '');
  const [description, setDescription] = useState(request.description ?? '');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [withDiagnostics, setWithDiagnostics] = useState(true);
  const [withErrors, setWithErrors] = useState(!!request.error || request.kind === 'bug');
  const [ctx, setCtx] = useState<Context>({ diagnostics: [], errors: [] });
  const [report, setReport] = useState<Report>();
  const [preview, setPreview] = useState(false);
  const where = request.where ?? view;

  useEffect(() => {
    void call<Context>('feedback.context', { appVersion: info?.appVersion, screen: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`, theme: settings?.theme }).then(setCtx, () => undefined);
  }, []);
  const errors = useMemo(() => [...(request.error ? [request.error] : []), ...ctx.errors], [ctx.errors, request.error]);
  // a problem report includes the recent errors unless the user switched them off; other kinds leave them out
  const [errorsTouched, setErrorsTouched] = useState(false);
  useEffect(() => {
    if (!errorsTouched) setWithErrors(kind === 'bug' && errors.length > 0);
  }, [kind, errors.length, errorsTouched]);
  // the report is rebuilt as the user types, so the preview is always what will be sent
  useEffect(() => {
    const t = setTimeout(
      () =>
        void call<Report>('feedback.compose', {
          kind,
          title,
          description,
          steps,
          expected,
          where,
          diagnostics: withDiagnostics ? ctx.diagnostics : undefined,
          errors: withErrors && errors.length ? errors : undefined,
        }).then(setReport, () => undefined),
      200,
    );
    return () => clearTimeout(t);
  }, [kind, title, description, steps, expected, where, withDiagnostics, withErrors, ctx.diagnostics, errors]);

  const ready = !!title.trim() && !!description.trim();
  const copy = async (quiet = false) => {
    if (!report) return;
    await navigator.clipboard.writeText(`# ${report.title}\n\n${report.body}`);
    if (!quiet) useApp.getState().toast('Report copied', 'success');
  };
  const openGitHub = async () => {
    if (!report) return;
    // a long report doesn't fit in a link: the full text is on the clipboard to paste
    if (report.shortened) await copy(true);
    // the desktop app opens the system browser; the browser version a new tab
    if (info?.nativeDialogs) await call('app.openExternal', { url: report.url });
    else window.open(report.url, '_blank', 'noopener');
    useApp.getState().toast(report.shortened ? 'GitHub opened with a shortened report: the full report is on your clipboard to paste' : 'GitHub opened: review the report and click Submit new issue', 'success');
    onClose();
  };
  /** An email to the maintainer in the user's mail app (no GitHub account needed). */
  const email = async () => {
    if (!report) return;
    if (report.mailShortened) await copy(true);
    if (info?.nativeDialogs) await call('app.openExternal', { url: report.mailto });
    else window.location.href = report.mailto;
    useApp.getState().toast(report.mailShortened ? 'Your mail app opened with a shortened report: the full report is on your clipboard to paste' : 'Your mail app opened with the report: review it and send', 'success');
    onClose();
  };
  const save = async () => {
    if (!report) return;
    try {
      finishSave(await call<SaveResult>('feedback.save', { title: report.title, body: report.body }), 'Report');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Modal
      title="Send feedback"
      onClose={onClose}
      width={640}
      footer={
        <>
          <span className="text-xs text-muted mr-auto">Nothing is sent until you post it on GitHub or send the email yourself.</span>
          <Button icon={<Copy size={13} />} disabled={!ready} onClick={() => void copy()}>
            Copy
          </Button>
          <Button icon={<Download size={13} />} disabled={!ready} onClick={() => void save()}>
            Save as file
          </Button>
          <Button icon={<Mail size={13} />} disabled={!ready} onClick={() => void email()} title="Opens your mail app with the report addressed to the TestPion maintainer; no GitHub account needed">
            Email
          </Button>
          <Button variant="primary" icon={<ExternalLink size={13} />} disabled={!ready} onClick={() => void openGitHub()} title="Opens a new GitHub issue with this report filled in; you review it and post it">
            Open on GitHub
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="What kind of feedback">
          {KINDS.map((k) => (
            <button
              key={k.id}
              role="radio"
              aria-checked={kind === k.id}
              onClick={() => setKind(k.id)}
              className={cx('flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-sm transition-colors', kind === k.id ? 'border-accent bg-accent-soft text-fg' : 'border-line hover:bg-hover text-muted')}
              title={k.hint}
            >
              {k.icon}
              <span className="font-medium">{k.label}</span>
            </button>
          ))}
        </div>
        <Field label="Title">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'bug' ? 'Sending a request with a large body freezes the window' : kind === 'ui' ? 'The Load view is hard to read on a small screen' : 'Import from Swagger 2 with examples'} />
        </Field>
        <Field label={kind === 'bug' ? 'What happened' : kind === 'question' ? 'Your question' : 'Tell us more'}>
          <textarea className="field min-h-24" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={kind === 'bug' ? 'What you saw, and anything that seems related' : 'What you would like, and why it would help'} />
        </Field>
        {kind === 'bug' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Steps to reproduce (optional)">
              <textarea className="field min-h-20" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder={'1. Open …\n2. Click …'} />
            </Field>
            <Field label="What you expected (optional)">
              <textarea className="field min-h-20" value={expected} onChange={(e) => setExpected(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Toggle checked={withDiagnostics} onChange={setWithDiagnostics} label="Include versions and platform (TestPion, OS, window size)" />
          <Toggle checked={withErrors} onChange={(v) => (setErrorsTouched(true), setWithErrors(v))} label={`Include the app's recent errors (${errors.length})`} />
          <span className="text-xs text-muted">Never included: your requests, responses, collections, environments or workspace names. Home folders and secret-looking values are masked.</span>
        </div>
        <div>
          <LinkButton className="text-sm" onClick={() => setPreview(!preview)} aria-expanded={preview}>
            {preview ? 'Hide' : 'Show'} the report that will be sent
          </LinkButton>
          {preview && report && <pre className="mt-2 mono text-xs bg-bg border border-line rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap">{`# ${report.title}\n\n${report.body}`}</pre>}
        </div>
      </div>
    </Modal>
  );
}
