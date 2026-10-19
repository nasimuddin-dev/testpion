import { useApp } from '../store';

/**
 * Whether the AI actions are shown (Settings ▸ AI assistant ▸ "Hide all AI actions" is off). A control that opens an AI
 * surface — a button, a palette command, a rail icon — renders only when this is true; see lib/ai-visible.ts.
 */
export const useAiEnabled = (): boolean => useApp((s) => s.settings?.ai?.hidden !== true);
