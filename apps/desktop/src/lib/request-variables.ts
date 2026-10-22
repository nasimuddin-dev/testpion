import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useApp, type ViewId } from '../store';
import { useDebounced } from '../components/ui';
import { inspectVariables } from './vars-cache';
import { VARS_CHANGED } from './var-popover';
import { on } from '../api';
import { isTemplateBlock, namesSetByScripts, scriptsOf, templateRegex, templatedText } from '@testpion/shared';

/**
 * The request open in the active editor, for the environment switcher's badge of undefined {{variables}}. An editor
 * publishes its tab on screen while it is the view on screen; the badge asks `vars.inspect` (the same resolution as the
 * field highlighting and the Info panel) a moment after typing stops.
 */
export interface OnScreenRequest {
  view: ViewId;
  /** The request's {{variables}}, each once, as a small template (not the whole body). */
  template: string;
  /** Names its own scripts set (`tp.environment.set('token', …)`): defined by the time it is sent. */
  setByScripts: string[];
  collectionId?: string;
}

const useOnScreen = create<{ request?: OnScreenRequest }>(() => ({}));

/**
 * The {{variables}} a request uses, each once, as a template; and the names its scripts set. Only its templated text
 * counts (`templatedText`, shared with the Info panel and the usage scanner): a {{name}} inside a script, such as a
 * visualizer's Handlebars template, is not a variable, and Handlebars blocks ({{#each}}, {{/each}}, {{else}}) never are.
 */
export function requestVariables(request: object): { template: string; setByScripts: string[] } {
  const refs = [...templatedText(request).matchAll(templateRegex())].filter((m) => !isTemplateBlock(m[1]!)).map((m) => m[0]);
  return { template: [...new Set(refs)].join(' '), setByScripts: [...namesSetByScripts(scriptsOf(request).join('\n'))] };
}

/** How long after the last edit the request on screen is reduced to its variables. */
const SETTLE_MS = 300;
function reduce(request: object | undefined): { template: string; setKey: string } | undefined {
  if (request === undefined) return undefined;
  const v = requestVariables(request);
  return { template: v.template, setKey: v.setByScripts.join(' ') };
}

/**
 * An editor says which request it shows (`request`: the saved request's shape, `{ request, preRequestScript, testScript }`;
 * `undefined`: none); only the editor on screen (`active`) is heard. It is reduced to its variables here, once per change.
 */
export function usePublishRequest(view: ViewId, request: object | undefined, collectionId: string | undefined, active = true): void {
  // reduced once typing paused (a keystroke in a 2 MB body no longer stringifies and scans the whole request), and the
  // editor renders again only when its variables changed
  const [vars, setVars] = useState(() => reduce(request));
  useEffect(() => {
    const t = setTimeout(
      () => {
        const next = reduce(request);
        setVars((cur) => (next?.template === cur?.template && next?.setKey === cur?.setKey ? cur : next));
      },
      request === undefined ? 0 : SETTLE_MS,
    );
    return () => clearTimeout(t);
  }, [request]);
  const template = vars?.template;
  const setKey = vars?.setKey;
  useEffect(() => {
    if (!active) return;
    const request = template === undefined ? undefined : { view, template, setByScripts: setKey ? setKey.split(' ') : [], collectionId };
    useOnScreen.setState({ request });
    return () => {
      if (useOnScreen.getState().request === request) useOnScreen.setState({ request: undefined });
    };
  }, [view, template, setKey, collectionId, active]);
}

export { namesSetByScripts };

/** The variables of `described` that are not defined: no scope, not dynamic ($guid, $env.X), not set by the request's scripts. */
export function undefinedVariables(described: Array<{ name: string; scope?: string }>, setByScripts: Iterable<string>): string[] {
  const set = new Set(setByScripts);
  return [...new Set(described.filter((v) => !v.scope && !v.name.startsWith('$') && !set.has(v.name) && !set.has(v.name.split('.')[0]!)).map((v) => v.name))];
}

/**
 * The {{variables}} the request on screen uses that the active environment, its collection and the globals don't
 * define; updated 400 ms after typing stops, on switching environment and when variables change.
 */
export function useUndefinedVariables(): { names: string[]; collectionId?: string } {
  const view = useApp((s) => s.view);
  const environment = useApp((s) => s.environment);
  const envsVersion = useApp((s) => s.envsVersion);
  const request = useOnScreen((s) => s.request);
  const shown = request && request.view === view ? request : undefined;
  // the editor publishes its variables once typing paused (usePublishRequest, 300 ms): a short wait more for switches
  const text = useDebounced(shown?.template ?? '', 100);
  const setByScripts = shown?.setByScripts;
  const collectionId = shown?.collectionId;
  const [names, setNames] = useState<string[]>([]);
  // a variable added or changed (the popover's Add, the Environments view, another window): look again
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const bump = () => setAgain((n) => n + 1);
    window.addEventListener(VARS_CHANGED, bump);
    const off = on('data.changed', bump);
    return () => (window.removeEventListener(VARS_CHANGED, bump), off());
  }, []);
  useEffect(() => {
    if (!text.includes('{{')) return setNames((n) => (n.length ? [] : n));
    let live = true;
    void inspectVariables({ environment, collectionId, template: text }).then(
      (list) => {
        if (!live) return;
        const next = undefinedVariables(list, setByScripts ?? []);
        setNames((cur) => (same(cur, next) ? cur : next));
      },
      () => live && setNames([]),
    );
    return () => {
      live = false;
    };
  }, [text, environment, collectionId, envsVersion, again, setByScripts]);
  return { names: shown ? names : [], collectionId };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
