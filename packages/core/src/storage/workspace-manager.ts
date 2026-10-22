import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppSettings, Workspace } from '../model/types.js';
import { defaultSettings } from '../model/types.js';
import { normalizeUiPrefs } from '../model/ui-prefs.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import { isInside, readJson, samePath, writeJson, realPathOf } from './fsutil.js';
import { WorkspaceStore } from './workspace.js';
import { markTemplateInstalled } from './template-update.js';
import { importWorkspaceBundle, type WorkspaceBundle } from './workspace-bundle.js';
import { looksLikeWorkspace } from './normalize.js';
import { workspaceFileValue } from './stable-files.js';

/**
 * The list of workspaces and the global settings under the app directory. (Its own module: workspace.ts is the store of one workspace.)
 */
/* ------------------------------------------------------------------ app-level manager */

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
}

import { defaultAppDir } from './app-dir.js';

/** Manages the list of workspaces and global settings under the app directory. */
export class WorkspaceManager {
  constructor(readonly appDir = defaultAppDir()) {
    mkdirSync(join(appDir, 'workspaces'), { recursive: true });
  }

  get settingsPath(): string {
    return join(this.appDir, 'settings.json');
  }

  /** Problem found while loading settings (e.g. a broken file: defaults are used until settings are saved). */
  settingsProblem?: string;

  loadSettings(): AppSettings {
    let s: Partial<AppSettings> = {};
    try {
      s = readJson<Partial<AppSettings>>(this.settingsPath, {});
      // a file that is JSON but not an object (null, a list, a string) holds no settings: defaults, like a broken file
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        this.settingsProblem = 'settings.json is not a JSON object';
        s = {};
      }
    } catch (e) {
      // a broken settings.json stays as it is; start from defaults (saving settings keeps a copy, settings.json.broken-<ts>)
      this.settingsProblem = (e as Error).message;
    }
    // revision 2 (redesigned UI): the default font size went from 13 to 14px — move people still on the old default
    if ((s.settingsRevision ?? 1) < 2 && s.fontSize === 13) s.fontSize = 14;
    // forget workspaces that lived in the system temp folder and are gone (test runs used to add them);
    // other missing paths stay listed, e.g. a workspace on a drive that isn't connected right now
    if (Array.isArray(s.workspacePaths)) {
      // the temp folder as named and really (macOS: /var/folders/… is /private/var/folders/…, as a CLI run records it)
      const tmps = [...new Set([tmpdir(), realPathOf(tmpdir())].map((t) => t.toLowerCase()))];
      s.workspacePaths = s.workspacePaths.filter((p) => !(typeof p === 'string' && tmps.some((t) => p.toLowerCase().startsWith(t)) && !existsSync(p)));
    }
    return { ...defaultSettings(), ...normalizeUiPrefs(s), settingsRevision: 2 };
  }

  saveSettings(s: AppSettings): AppSettings {
    writeJson(this.settingsPath, s);
    return s;
  }

  list(): WorkspaceInfo[] {
    const dirs = readdirSync(join(this.appDir, 'workspaces'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(this.appDir, 'workspaces', d.name));
    const extra = this.loadSettings().workspacePaths ?? [];
    const out: WorkspaceInfo[] = [];
    for (const p of [...dirs, ...extra]) {
      try {
        const w = readJson<Workspace>(join(p, 'workspace.json'));
        if (!looksLikeWorkspace(w)) continue;
        // the same folder listed twice (by a link to it and by its real path, as an older version could add it): once
        if (out.some((x) => x.id === w.id && samePath(x.path, p))) continue;
        out.push({ id: w.id, name: w.name, path: p, updatedAt: w.updatedAt });
      } catch {
        /* skip invalid */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve a workspace by id, name, slug or filesystem path. */
  resolve(ref: string): string | undefined {
    if (existsSync(join(ref, 'workspace.json'))) return resolve(ref);
    const r = ref.toLowerCase();
    return this.list().find((w) => w.id === ref || w.name.toLowerCase() === r || basename(w.path) === slugify(ref))?.path;
  }

  create(name: string, path?: string): WorkspaceStore {
    let root = path ?? join(this.appDir, 'workspaces', slugify(name));
    if (!path) {
      let i = 2;
      while (existsSync(root)) root = join(this.appDir, 'workspaces', `${slugify(name)}-${i++}`);
    }
    const s = WorkspaceStore.create(root, name);
    if (path) this.rememberWorkspacePath(root);
    return s;
  }

  /** Add a folder the user opened, cloned or created to the workspace list, once (by any name: a link, its real path). */
  rememberWorkspacePath(dir: string): AppSettings {
    const settings = this.loadSettings();
    if (settings.workspacePaths.some((p) => typeof p === 'string' && samePath(p, dir))) return settings;
    return this.saveSettings({ ...settings, workspacePaths: [...settings.workspacePaths, dir] });
  }

  open(ref: string): WorkspaceStore {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`, { suggestions: [`Known workspaces: ${this.list().map((w) => w.name).join(', ') || 'none'}`] });
    return WorkspaceStore.open(p);
  }

  duplicate(ref: string, newName: string): WorkspaceInfo {
    const src = this.resolve(ref);
    if (!src) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    let dest = join(this.appDir, 'workspaces', slugify(newName));
    let i = 2;
    while (existsSync(dest)) dest = join(this.appDir, 'workspaces', `${slugify(newName)}-${i++}`);
    cpSync(src, dest, {
      recursive: true,
      // copy definitions, not execution artefacts
      filter: (s) => {
        const top = relative(src, s).split(/[\\/]/)[0] ?? '';
        return !['runs', 'traces', 'payloads', 'reports', 'trash'].includes(top) && !/^(database\.sqlite.*|metadata\.jsonl)$/.test(basename(s));
      },
    });
    const w = readJson<Workspace>(join(dest, 'workspace.json'));
    const next = { ...w, id: shortId('ws-'), name: newName, updatedAt: new Date().toISOString() };
    writeJson(join(dest, 'workspace.json'), workspaceFileValue(next));
    return { id: next.id, name: newName, path: dest, updatedAt: next.updatedAt };
  }

  /**
   * Copy a bundled workspace (such as the examples that ship with the app) into the data folder, once:
   * if a workspace with the same id is already there, that one is returned untouched, so the user's
   * edits survive app updates. Execution artefacts are never copied.
   */
  installTemplate(templateDir: string): WorkspaceInfo {
    const w = readJson<Workspace>(join(templateDir, 'workspace.json'));
    const existing = this.list().find((x) => x.id === w.id);
    if (existing) return existing;
    let dest = join(this.appDir, 'workspaces', slugify(w.name));
    let i = 2;
    while (existsSync(dest)) dest = join(this.appDir, 'workspaces', `${slugify(w.name)}-${i++}`);
    cpSync(templateDir, dest, {
      recursive: true,
      filter: (s) => {
        const top = relative(templateDir, s).split(/[\\/]/)[0] ?? '';
        return !['runs', 'traces', 'payloads', 'reports', 'baselines', 'trash', '.local'].includes(top) && !/^(database\.sqlite.*|metadata\.jsonl)$/.test(basename(s));
      },
    });
    // everything in the template was offered: later versions add only what is new (addTemplateAdditions)
    markTemplateInstalled(templateDir, dest);
    return { id: w.id, name: w.name, path: dest, updatedAt: w.updatedAt };
  }

  /** Whether the app created this workspace (in its data folder's workspaces/, as named or really) rather than a folder the user opened. */
  isManaged(path: string): boolean {
    return isInside(resolve(this.appDir, 'workspaces'), path);
  }

  /** A workspace with counts of what it holds, e.g. for a delete confirmation. */
  details(ref: string): WorkspaceInfo & { managed: boolean; collections: number; environments: number; tests: number } {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    const w = readJson<Workspace>(join(p, 'workspace.json'));
    const count = (dir: string, re: RegExp): number => {
      const d = join(p, dir);
      if (!existsSync(d)) return 0;
      let n = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? count(join(dir, e.name), re) : re.test(e.name) ? 1 : 0;
      return n;
    };
    return { id: w.id, name: w.name, path: p, updatedAt: w.updatedAt, managed: this.isManaged(p), collections: count('collections', /\.json$/), environments: count('environments', /\.json$/), tests: count('tests', /\.ya?ml$/) };
  }

  /** Rename a workspace that isn't open (the open one is renamed through its store). */
  rename(ref: string, name: string): WorkspaceInfo {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    if (!name.trim()) throw new ApsError('ValidationError', 'The workspace name is empty');
    const file = join(p, 'workspace.json');
    const w = { ...readJson<Workspace>(file), name: name.trim(), updatedAt: new Date().toISOString() };
    writeJson(file, workspaceFileValue(w));
    return { id: w.id, name: w.name, path: p, updatedAt: w.updatedAt };
  }

  /**
   * Remove a workspace. Folders the app created are deleted; folders the user opened are only removed
   * from the list (their files stay). Close the workspace first if it is open.
   */
  delete(ref: string): { deletedFiles: boolean } {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    const managed = this.isManaged(p);
    // only delete files for workspaces the app created; external folders are just unregistered
    if (managed) {
      try {
        // Windows: files can be briefly locked (SQLite, antivirus, an indexer); retry before giving up
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        throw new ApsError('ConfigurationError', `Could not delete the workspace folder ${p}: ${e instanceof Error ? e.message : String(e)}. Close programs using it and try again.`);
      }
    }
    const settings = this.loadSettings();
    this.saveSettings({ ...settings, workspacePaths: settings.workspacePaths.filter((x) => !samePath(x, p)), ...(settings.lastWorkspace && samePath(settings.lastWorkspace, p) ? { lastWorkspace: undefined } : {}) });
    return { deletedFiles: managed };
  }

  /** Import an export as a new workspace (workspace-bundle.ts; `importWorkspaceBundle` also says what was skipped and what to fill in). */
  importBundle(bundle: WorkspaceBundle, name?: string): WorkspaceStore {
    return importWorkspaceBundle(this, bundle, name).store;
  }
}

