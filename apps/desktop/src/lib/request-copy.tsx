import { Braces, Code2, Link2, SquareTerminal, Terminal, TerminalSquare } from 'lucide-react';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { Collection, SavedHttpRequest } from '../types';
import type { MenuItem } from '../components/ui';
import { fullCollection } from './collections-store';
import { findNode } from './collection-nodes';
import { LABEL } from './vocabulary';

/** Copy a saved request as its URL or as code, with variables resolved from the active environment. */
async function copyRequestAs(c: Collection, shown: SavedHttpRequest, language: string, what: string): Promise<void> {
  try {
    // the tree shows outlines: the request as the whole collection holds it (its headers, body, auth)
    const n = (findNode((await fullCollection(c)).items, shown.id) as SavedHttpRequest | undefined) ?? shown;
    const r = await call<{ text: string; containsSecrets: boolean }>('http.copyCode', {
      request: n.request,
      environment: useApp.getState().environment,
      collectionId: c.id,
      requestId: n.id,
      language,
    });
    await navigator.clipboard.writeText(r.text);
    useApp.getState().toast(`Copied ${what}${r.containsSecrets ? ' (it includes secret values such as tokens)' : ''}`, 'success');
  } catch (e) {
    useApp.getState().toast(`Couldn't copy: ${asError(e).message}`, 'error');
  }
}

/** Copy as ▸ of an HTTP request (its row in the tree, a favorite): the URL, then the code forms. */
export function requestCopyItems(c: Collection, n: SavedHttpRequest): MenuItem[] {
  return [
    { label: LABEL.copyUrl, icon: <Link2 size={14} />, onSelect: () => void copyRequestAs(c, n, 'url', 'the URL') },
    { label: 'cURL (bash)', icon: <Terminal size={14} />, onSelect: () => void copyRequestAs(c, n, 'curl', 'as cURL (bash)') },
    { label: 'cURL (cmd)', icon: <SquareTerminal size={14} />, onSelect: () => void copyRequestAs(c, n, 'curl-windows', 'as cURL (cmd)') },
    { label: 'PowerShell', icon: <TerminalSquare size={14} />, onSelect: () => void copyRequestAs(c, n, 'powershell', 'as PowerShell') },
    { label: 'fetch', icon: <Braces size={14} />, onSelect: () => void copyRequestAs(c, n, 'fetch', 'as fetch') },
    { label: 'More code snippets…', icon: <Code2 size={14} />, onSelect: () => useApp.getState().openIntent('rest', { collectionId: c.id, requestId: n.id, showCode: true }) },
  ];
}
