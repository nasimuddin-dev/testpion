import { asError } from '../api';
import { useApp } from '../store';
import { aiSetupActionFor } from './ai-setup';

/**
 * The one way the window offers to fix an AI setup problem, wherever it shows up (see ai-setup.ts for the decision; this
 * one reads the window's state).
 */
export const aiSetupAction = (e: unknown) => aiSetupActionFor(e, () => useApp.getState());

/** An AI action failed: the message, with the setup action when that is what is missing. */
export function toastAiError(e: unknown): void {
  useApp.getState().toast(asError(e).message, 'error', aiSetupAction(e));
}
