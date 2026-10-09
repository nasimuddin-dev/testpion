import { Component, lazy, Suspense, type ReactNode } from 'react';
import { MessageSquareWarning, RefreshCw, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../store';
import { reportClientError } from '../lib/error-capture';
import { Button, cx, TooltipProvider } from './ui';
import { dropDraft } from '../lib/draft-store';
import type { FeedbackRequest } from './FeedbackDialog';

const FeedbackDialog = lazy(() => import('./FeedbackDialog').then((m) => ({ default: m.FeedbackDialog })));

/** The saved draft (persisted state) of each view, which "Reset this view" clears. */
const DRAFT_KEYS: Record<string, string[]> = {
  rest: ['aps.draft.rest'],
  graphql: ['aps.draft.graphql'],
  grpc: ['aps.draft.grpc'],
  websocket: ['aps.draft.websocket'],
  ai: ['aps.draft.ai'],
  evaluations: ['aps.draft.eval'],
  load: ['aps.draft.load'],
};

/**
 * A part of the app that could not be downloaded (a lazy chunk): React caches the failed import, so "Try again" can
 * never recover it; only a reload of the window does (after an update, or a build replaced underneath).
 */
export function isChunkLoadError(error: unknown): boolean {
  const m = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading (CSS )?chunk \S+ failed/i.test(m);
}

interface Props {
  /** The view's id (its draft keys, the report's "where"), or the name of the part for the other variants. */
  view: string;
  /**
   * view: a panel in place of the view (the default). bar: one compact line in place of a part of the window (the
   * top bar, the status bar, a dialog). app: the whole window, when nothing else could catch the error.
   */
  variant?: 'view' | 'bar' | 'app';
  /** A human name for the part ("top bar"); the view id otherwise. */
  label?: string;
  /** For a dialog: closing it is the way out (its Try again would fail the same way). */
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}

interface State {
  error?: Error;
  /** The app variant's own Report a problem dialog (the app's is gone with the app). */
  reporting?: boolean;
}

/**
 * Keeps one broken part from blanking the whole window: shows what went wrong with Try again (Reload when a part of
 * the app could not be loaded), Report a problem and, for a view, Reset this view (which forgets the view's unsaved
 * draft, the usual cause after an upgrade). The same component guards views, the window's bars and dialogs, and the
 * whole app.
 */
export class ViewBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'An unexpected error') };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`View "${this.props.view}" failed:`, error, info.componentStack);
    reportClientError(error, `${this.props.variant === 'app' ? 'app' : 'view'} ${this.props.view}`);
  }

  private reset = (clearDraft: boolean) => {
    if (clearDraft) for (const k of DRAFT_KEYS[this.props.view] ?? []) dropDraft(k.replace(/^aps\.draft\./, ''));
    this.setState({ error: undefined });
  };

  private report = () => {
    const { error } = this.state;
    if (!error) return;
    const name = this.props.label ?? this.props.view;
    const request: FeedbackRequest = {
      kind: 'bug',
      title: this.props.variant === 'app' ? 'TestPion stopped with an error' : this.props.variant === 'bar' ? `The ${name} stopped with an error` : `The ${name} view stopped with an error`,
      where: this.props.view,
      error: `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}`,
    };
    if (this.props.variant === 'app') this.setState({ reporting: true });
    else useApp.getState().set({ feedback: request });
  };

  private actions(size: 'sm' | 'md') {
    const { error } = this.state;
    const chunk = isChunkLoadError(error);
    const { variant, onDismiss } = this.props;
    return (
      <>
        <Button size={size} className={variant === 'bar' ? undefined : 'mr-auto'} icon={<MessageSquareWarning size={13} />} onClick={this.report}>
          Report a problem
        </Button>
        {chunk || variant === 'app' ? (
          <Button size={size} variant={variant === 'app' ? 'primary' : 'default'} icon={<RefreshCw size={13} />} onClick={() => window.location.reload()}>
            Reload
          </Button>
        ) : (
          <Button size={size} icon={<RotateCcw size={13} />} onClick={() => this.reset(false)}>
            Try again
          </Button>
        )}
        {variant !== 'app' && variant !== 'bar' && !chunk && DRAFT_KEYS[this.props.view] && (
          <Button size={size} variant="primary" onClick={() => this.reset(true)}>
            Reset this view
          </Button>
        )}
        {onDismiss && (
          <Button
            size={size}
            icon={<X size={13} />}
            onClick={() => {
              this.setState({ error: undefined });
              onDismiss();
            }}
          >
            Close
          </Button>
        )}
      </>
    );
  }

  render() {
    const { error, reporting } = this.state;
    if (!error) return this.props.children;
    const { variant = 'view', className } = this.props;
    const chunk = isChunkLoadError(error);
    const name = this.props.label ?? this.props.view;
    if (variant === 'bar')
      return (
        <div role="alert" className={cx('flex items-center gap-2 px-3 py-1 min-h-8 shrink-0 text-xs border-line bg-panel text-muted', className)}>
          <TriangleAlert size={14} className="text-warn shrink-0" />
          <span className="min-w-0 truncate" title={error.message}>
            <span className="text-fg">{chunk ? `A part of TestPion (${name}) could not be loaded.` : `The ${name} ran into a problem.`}</span> {error.message}
          </span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0">{this.actions('sm')}</span>
        </div>
      );
    const app = variant === 'app';
    return (
      <div className={cx('h-full w-full grid place-items-center p-8', app && 'bg-bg text-fg', className)}>
        <div role="alert" className="max-w-lg w-full rounded-xl border border-line bg-panel p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 font-semibold">
            <TriangleAlert size={18} className="text-warn" />
            {app ? 'TestPion ran into a problem' : chunk ? 'This view could not be loaded' : 'This view ran into a problem'}
          </div>
          <p className="text-sm text-muted">
            {app
              ? 'Reload the window to go on: saved collections, requests and environments are not affected. If it happens again, report it with the details below.'
              : chunk
                ? 'A part of TestPion could not be loaded, usually after an update. Reload the window to go on (saved collections, requests and environments are not affected).'
                : 'The rest of TestPion still works. Try again, or reset this view to start from a clean draft (saved collections, requests and environments are not affected).'}
          </p>
          <pre className="text-xs mono bg-bg border border-line rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap">{error.message}</pre>
          <div className="flex gap-2 justify-end">{this.actions('md')}</div>
        </div>
        {app && reporting && (
          <TooltipProvider>
            <ViewBoundary view="feedback" variant="bar" label="report dialog" onDismiss={() => this.setState({ reporting: false })}>
              <Suspense fallback={null}>
                <FeedbackDialog
                  request={{ kind: 'bug', title: 'TestPion stopped with an error', where: name, error: `${error.message}\n${(error.stack ?? '').split('\n').slice(1, 6).join('\n')}` }}
                  onClose={() => this.setState({ reporting: false })}
                />
              </Suspense>
            </ViewBoundary>
          </TooltipProvider>
        )}
      </div>
    );
  }
}
