import { createElement } from 'react';
import { FolderPlus, KeyRound, Plus, Send, Upload } from 'lucide-react';
import type { EmptyAction } from '../components/ui';
import { useApp } from '../store';

/**
 * The first steps an empty state offers (WF-18), made once so the Home cards, the sidebar panes and the views offer the
 * identical button for the identical step: the same words, icon and intent. A view that is on screen handles the intent
 * itself (Collections ▸ New collection asks for the name; Environments ▸ New environment likewise).
 */
const icon = (c: typeof Plus) => createElement(c, { size: 13 });
const go = useApp.getState;

export const newCollectionAction = (): EmptyAction => ({ label: 'New collection', icon: icon(FolderPlus), onClick: () => go().openIntent('collections', { create: true }) });
export const importAction = (): EmptyAction => ({ label: 'Import…', icon: icon(Upload), onClick: () => go().openIntent('collections', { import: true }) });
export const newEnvironmentAction = (): EmptyAction => ({ label: 'New environment', icon: icon(KeyRound), onClick: () => go().openIntent('environments', { create: true }) });
export const sendRequestAction = (): EmptyAction => ({ label: 'Send a request', icon: icon(Send), onClick: () => go().openIntent('rest', { newTab: true }) });
export const newRequestAction = (): EmptyAction => ({ label: 'New HTTP request', icon: icon(Plus), onClick: () => go().openIntent('rest', { newTab: true }) });
