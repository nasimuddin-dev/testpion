export function isSuiteFile(p: string): boolean {
  return /\.suite\.(ya?ml|json)$/i.test(p);
}
