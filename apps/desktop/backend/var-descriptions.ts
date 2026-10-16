/**
 * What each {{variable}} name holds in a context and where it comes from (secret values masked): one answer for the
 * field highlighting (`vars.inspect`), the Info panel (`ref.info`) and the environment switcher's badge of undefined
 * variables, so they never disagree. A name without a scope is not defined there.
 */
export interface VarDescription {
  name: string;
  scope?: string;
  value?: string;
  secret?: boolean;
}

export function describeVariables(vars: { describe(name: string): { scope?: string; value?: unknown; secret?: boolean } | undefined }, names: string[], maxValue?: number): VarDescription[] {
  return names.map((name) => {
    const d = vars.describe(name);
    const text = d ? (d.secret ? '••••••' : String(typeof d.value === 'object' ? JSON.stringify(d.value) : d.value)) : undefined;
    return { name, scope: d?.scope, value: text !== undefined && maxValue ? text.slice(0, maxValue) : text, secret: d?.secret };
  });
}
