import { useApp, type AskSearchRequest } from '../../store';

/** Open "Ask…" (AI-12): the one way, from the search box, the palette and the filter bars of History, Runs and Traces. */
export function startAskSearch(req: AskSearchRequest = {}): void {
  useApp.getState().set({ askSearch: req, searchOpen: false, paletteOpen: false, paletteQuery: undefined });
}

/** What the History, Runs and Traces filter bars ask about: the sources of their view. */
export const ASK_SCOPE = { history: ['history'], runs: ['runs', 'results'], traces: ['traces'] } as const;
