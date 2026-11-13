import { reproBundle, type ReproOptions } from '../debugger/repro.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { gitRemoteUrl } from './git.js';

/**
 * An issue for a failed run (`testpion debug-export --run … --issue`, RPC `runs.issue`, the app's Create issue…, the
 * `issue` of MCP `debugger_session` with `run`): a title and a Markdown text that say what failed, written without a
 * model from what the run kept: each failed step's request line and status, the checks that failed with what was
 * expected and what came, the errors. Secrets are masked the strict way (the text is the repro bundle's notes).
 *
 * Nothing is sent anywhere: where the workspace's remote is GitHub, GitLab or Bitbucket there is also a link that opens
 * that site's new-issue page with the title and text filled in, for a person to read and submit.
 */
export interface IssueDraft {
  title: string;
  body: string;
  /** The new-issue page of the workspace's remote, filled in; absent when there is no remote or it is another kind of host. */
  url?: string;
  /** The site the link opens ("GitHub", "GitLab", "Bitbucket"). */
  tracker?: string;
  run: { id: string; name: string };
  steps: Array<{ id: string; name: string; status: string }>;
}

/** The longest text a new-issue link carries (browsers and the sites take about 8,000 characters of URL). */
const URL_BODY = 5000;

/** A link that opens the new-issue page of a remote's website with the title and text filled in: GitHub, GitLab, Bitbucket. */
export function newIssueUrl(remote: string, title: string, body: string): { url: string; tracker: string } | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m) return undefined;
  const host = m[1]!.toLowerCase();
  const path = m[2]!.replace(/^\/+/, '');
  const t = encodeURIComponent(title);
  const text = encodeURIComponent(body.length > URL_BODY ? `${body.slice(0, URL_BODY)}\n\n… (the text was cut for the link: paste the whole of it)` : body);
  if (host === 'github.com' || host.startsWith('github.')) return { tracker: 'GitHub', url: `https://${host}/${path}/issues/new?title=${t}&body=${text}` };
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return { tracker: 'GitLab', url: `https://${host}/${path}/-/issues/new?issue[title]=${t}&issue[description]=${text}` };
  if (host === 'bitbucket.org') return { tracker: 'Bitbucket', url: `https://${host}/${path}/issues/new?title=${t}&content=${text}` };
  return undefined;
}

export async function issueDraft(store: WorkspaceStore, runId: string, o: Pick<ReproOptions, 'results' | 'notes' | 'redactor'> & { /** The remote to link to (default: the workspace's origin). */ remote?: string } = {}): Promise<IssueDraft> {
  const r = await reproBundle(store, runId, { results: o.results, notes: o.notes, redactor: o.redactor });
  const failing = r.steps.filter((s) => s.status !== 'passed');
  // the first failure's own words are the title: "Create order: expected 201, got 422"
  const first = /^- \*\*[^*]+\*\*: (.+)$/m.exec(r.notes)?.[1]?.replace(/ \(expected .*\)$/, '');
  const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : '';
  const name = failing[0]?.name ?? r.run.name;
  const title = `${name}${first ? `: ${first}` : ' failed'}`.slice(0, 140 - more.length) + more;
  // the notes of the bundle, without the lines about opening the bundle: an issue is read on a website
  const body = [
    r.notes
      .replace(/^# Repro: .*\n+/m, '')
      .replace(/^This bundle holds .*\n/m, '')
      .replace(/^Open it in TestPion .*\n+/m, '')
      .trim(),
    '',
    '### To reproduce',
    '',
    `The requests and answers of this run are in a repro bundle (secrets masked): \`testpion debug-export --run ${r.run.id} -w . --bundle repro.tpbundle\`, or **Repro bundle…** in the run's menu. Attach it to this issue; it opens in TestPion (Debugger ▸ Open session).`,
    '',
  ].join('\n');
  const remote = o.remote ?? (await gitRemoteUrl(store.root).catch(() => undefined));
  const link = remote ? newIssueUrl(remote, title, body) : undefined;
  return { title, body, ...(link ?? {}), run: { id: r.run.id, name: r.run.name }, steps: r.steps };
}
