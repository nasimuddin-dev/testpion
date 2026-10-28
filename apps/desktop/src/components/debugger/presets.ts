/**
 * The ready-made rules the "Change this traffic" menu adds for a row's domain (ids and words of core's rulePresets; a unit
 * test keeps them the same): caching, encodings, the user agent, proxy sign-in.
 */
export const TRAFFIC_PRESETS: Array<{ id: string; label: string; title: string }> = [
  { id: 'no-cache', label: 'Disable caching', title: 'Ask for fresh answers: no If-None-Match, no If-Modified-Since, Cache-Control no-cache; answers are not cached' },
  { id: 'no-encoding', label: 'Remove all encodings', title: 'Remove Accept-Encoding, so servers answer in plain text and the bodies read as they are' },
  { id: 'gzip', label: 'Ask for gzip', title: 'Send Accept-Encoding: gzip, so servers compress their answers' },
];
export const USER_AGENT_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'ua-chrome', label: 'Chrome (Windows)' },
  { id: 'ua-firefox', label: 'Firefox (Windows)' },
  { id: 'ua-safari', label: 'Safari (Mac)' },
  { id: 'ua-iphone', label: 'iPhone' },
  { id: 'ua-android', label: 'Android phone' },
  { id: 'ua-bot', label: 'Search bot' },
];
export const REQUIRE_AUTH_PRESET = { id: 'require-auth', label: 'Require proxy sign-in (plain HTTP)', title: 'Answer plain HTTP requests that carry no proxy credentials with 407, so the program asks for them. Any user name and password pass.' };
