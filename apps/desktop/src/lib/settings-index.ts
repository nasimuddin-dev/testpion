/** What Settings is made of, for its search field and the one line under each tab: where a setting lives and what it applies to. */
export type SettingsTabId = 'appearance' | 'keyboard' | 'requests' | 'git' | 'proxy' | 'certificates' | 'privacy' | 'pricing' | 'load' | 'storage' | 'assistant' | 'about' | 'agents';

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'requests', label: 'Requests' },
  { id: 'git', label: 'Git' },
  { id: 'proxy', label: 'Proxy' },
  { id: 'certificates', label: 'Certificates' },
  { id: 'privacy', label: 'Privacy & security' },
  { id: 'pricing', label: 'Model pricing' },
  { id: 'load', label: 'Load testing' },
  { id: 'storage', label: 'Storage' },
  { id: 'assistant', label: 'AI assistant' },
  { id: 'agents', label: 'AI agents (MCP)' },
  { id: 'about', label: 'About' },
];

/** The line under a tab: what its settings apply to. Settings belong to the app on this computer, so most are for every workspace. */
export const SETTINGS_SCOPE: Record<SettingsTabId, string> = {
  appearance: 'Applies to: all workspaces on this computer.',
  keyboard: 'Applies to: all workspaces on this computer.',
  requests: 'Applies to: all workspaces on this computer.',
  git: 'Applies to: all workspaces on this computer.',
  proxy: 'Applies to: all workspaces on this computer.',
  certificates: 'Applies to: all workspaces on this computer.',
  privacy: 'Applies to: all workspaces on this computer. What scripts may do is remembered per workspace.',
  pricing: 'Applies to: all workspaces on this computer.',
  load: 'Applies to: all workspaces on this computer.',
  storage: 'Applies to: this workspace (its size and its runs); how long runs are kept applies to every workspace.',
  assistant: 'Applies to: all workspaces on this computer.',
  agents: 'Applies to: all workspaces on this computer.',
  about: 'Applies to: all workspaces on this computer.',
};

/** One setting the search finds: its label as the tab shows it, the tab, and other words people use for it. */
export interface SettingsEntry {
  tab: SettingsTabId;
  label: string;
  words?: string;
}

export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { tab: 'appearance', label: 'Theme', words: 'dark light mode colour color' },
  { tab: 'appearance', label: 'Density', words: 'compact comfortable spacing rows' },
  { tab: 'appearance', label: 'Response layout', words: 'side by side below split' },
  { tab: 'appearance', label: 'Font size', words: 'text zoom bigger smaller' },
  { tab: 'appearance', label: 'Reduce motion', words: 'animation animations' },
  { tab: 'appearance', label: 'Notify me when a run finishes while TestPion is in the background', words: 'notification desktop' },
  { tab: 'keyboard', label: 'Keyboard shortcuts', words: 'keys bindings rebind hotkeys' },
  { tab: 'requests', label: 'Default timeout (ms)', words: 'timeout seconds stop slow' },
  { tab: 'requests', label: 'Maximum response preview (MB)', words: 'large body truncated size' },
  { tab: 'requests', label: 'Log level', words: 'debug trace logging' },
  { tab: 'requests', label: 'Ask before sending a request that changes data with a variable that has no value', words: 'confirm unresolved variable post put patch delete warn' },
  { tab: 'git', label: 'Fetch in the background every (minutes)', words: 'auto fetch remote' },
  { tab: 'git', label: "Pull my team's commits by itself", words: 'auto pull fast-forward team remote' },
  { tab: 'proxy', label: 'Proxy URL', words: 'http proxy corporate' },
  { tab: 'proxy', label: 'Bypass the proxy for', words: 'no_proxy hosts' },
  { tab: 'proxy', label: 'User name (optional)', words: 'proxy login' },
  { tab: 'proxy', label: 'Password', words: 'proxy login secret' },
  { tab: 'certificates', label: 'Trust the certificates installed in the operating system', words: 'ca tls ssl system store' },
  { tab: 'certificates', label: 'Extra CA certificates (PEM)', words: 'ca tls ssl certificate authority corporate' },
  { tab: 'privacy', label: 'Always-redacted field names', words: 'redact secrets hide mask logs' },
  { tab: 'privacy', label: 'OS environment variables requests may read', words: 'env $env allow list' },
  { tab: 'privacy', label: 'Check for updates when the app starts', words: 'update github network telemetry' },
  { tab: 'privacy', label: 'What leaves this computer', words: 'network telemetry privacy' },
  { tab: 'privacy', label: 'What scripts were allowed', words: 'trust forget secrets hosts programs' },
  { tab: 'pricing', label: 'Model pricing', words: 'cost price tokens per million' },
  { tab: 'load', label: 'Allow load tests against remote (non-local) hosts by default', words: 'load remote hosts' },
  { tab: 'load', label: 'Maximum virtual users', words: 'vus load limit' },
  { tab: 'storage', label: 'Storage', words: 'disk space size clean up delete' },
  { tab: 'storage', label: 'Keep the newest runs', words: 'retention runs prune' },
  { tab: 'storage', label: 'Keep runs for (days)', words: 'retention age prune old' },
  { tab: 'assistant', label: 'Hide all AI actions', words: 'ai off disable' },
  { tab: 'assistant', label: 'Turn on the AI assistant', words: 'claude assistant enable' },
  { tab: 'assistant', label: 'Anthropic API key', words: 'claude key' },
  { tab: 'assistant', label: 'Provider', words: 'ai model assistant' },
  { tab: 'assistant', label: 'Model', words: 'ai assistant' },
  { tab: 'assistant', label: 'Wait for a model', words: 'ai timeout limits' },
  { tab: 'assistant', label: 'Silence in a stream', words: 'ai timeout limits' },
  { tab: 'agents', label: 'AI agents (MCP)', words: 'mcp claude code cursor copilot server command' },
  { tab: 'about', label: 'Check for updates when the app starts', words: 'update version' },
  { tab: 'about', label: 'Diagnostics bundle', words: 'bug report doctor support' },
  { tab: 'about', label: 'Export settings', words: 'backup copy another computer' },
  { tab: 'about', label: 'Import settings', words: 'restore copy another computer' },
  { tab: 'about', label: 'Reset settings', words: 'defaults factory' },
];

/** The entries (and tabs) that match what was typed: every word of it in the label, the tab's name or the extra words. */
export function searchSettings(query: string): SettingsEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const tabLabel = (id: SettingsTabId) => SETTINGS_TABS.find((t) => t.id === id)!.label.toLowerCase();
  const hits = SETTINGS_INDEX.filter((e) => {
    const hay = `${e.label} ${e.words ?? ''} ${tabLabel(e.tab)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // a tab named by the query leads (typing "proxy" finds the tab, then its settings)
  const tabs = SETTINGS_TABS.filter((t) => words.every((w) => t.label.toLowerCase().includes(w))).map((t) => ({ tab: t.id, label: `${t.label} (tab)` }));
  const seen = new Set<string>();
  return [...tabs, ...hits].filter((e) => !seen.has(`${e.tab}|${e.label}`) && !!seen.add(`${e.tab}|${e.label}`));
}
