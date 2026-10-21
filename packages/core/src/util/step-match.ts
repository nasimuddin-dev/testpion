/**
 * The one way two versions of a flow's steps are paired (B-41a). The Git view (git/flow-diff.ts, "step renamed", "step
 * changed") and the AI review (ai/flow-step-review.ts, "what the model changed against the draft") both ask the same question:
 * which step of this version is that step of the other one? They differ in the keys they trust, in their order, and in how
 * they word the answer, not in how the pairing works, so the pairing lives here and each caller supplies its keys and its
 * own output format.
 */

/** A key a step can be paired by (an id, a name, a method and path, a body…); undefined: this step has none of this kind. */
type StepKey<T> = (step: T, index: number) => string | undefined;

/**
 * For each of `seekers`, in order, the index of its partner in `pool`, or -1. A seeker tries the keys in order; for each key
 * it takes the first partner not taken yet whose key is equal. A partner is taken at most once.
 */
export function matchSteps<S, P>(seekers: readonly S[], pool: readonly P[], keys: ReadonlyArray<{ seek: StepKey<S>; pool: StepKey<P> }>): number[] {
  const taken = new Set<number>();
  return seekers.map((seeker, i) => {
    for (const key of keys) {
      const want = key.seek(seeker, i);
      if (want === undefined) continue;
      const j = pool.findIndex((p, k) => !taken.has(k) && key.pool(p, k) === want);
      if (j >= 0) {
        taken.add(j);
        return j;
      }
    }
    return -1;
  });
}

/** Two values are the same when they serialise the same (undefined counts as null). */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
