import { useState } from 'react';
import { searchSettings, SETTINGS_TABS, type SettingsTabId } from '../lib/settings-index';
import { FilterInput } from './ui';

/**
 * The search box at the top of Settings: type a word (timeout, proxy, dark, key) and the settings that match are listed with
 * their tab; a click, or Enter on the first, goes to the tab. Esc clears it.
 */
export function SettingsSearch({ onGo }: { onGo(tab: SettingsTabId): void }) {
  const [q, setQ] = useState('');
  const hits = searchSettings(q).slice(0, 8);
  const go = (tab: SettingsTabId) => {
    setQ('');
    onGo(tab);
  };
  return (
    <div className="flex flex-col gap-1" data-settings-search="">
      <FilterInput
        label="Search settings"
        placeholder="Search settings"
        value={q}
        onChange={setQ}
        className="w-72 max-w-full"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) {
            e.preventDefault();
            go(hits[0].tab);
          }
        }}
      />
      {q.trim() && (
        <ul className="rounded-md border border-line bg-panel text-sm w-96 max-w-full overflow-hidden" role="listbox" aria-label="Matching settings">
          {hits.length ? (
            hits.map((h) => (
              <li key={`${h.tab}|${h.label}`} role="option" aria-selected={false}>
                <button className="w-full text-left px-3 py-1.5 hover:bg-hover flex items-center gap-2" onClick={() => go(h.tab)}>
                  <span className="truncate flex-1">{h.label}</span>
                  <span className="text-xs text-muted shrink-0">{SETTINGS_TABS.find((t) => t.id === h.tab)!.label}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-muted">No setting matches "{q.trim()}".</li>
          )}
        </ul>
      )}
    </div>
  );
}
