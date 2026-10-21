/** The success response of an operation: its first exact 2xx code, else a `2XX`-style range. */
export function successCode(codes: string[]): string | undefined {
  return codes.find((c) => /^2\d\d$/.test(c)) ?? codes.find((c) => /^2/i.test(c));
}
