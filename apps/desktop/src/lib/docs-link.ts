/** TestPion's online documentation; `page` is a path in it such as 'api-testing/environments'. */
export const DOCS_URL = 'https://nasimuddin-dev.github.io/testpion/';

export function openDocs(page = ''): void {
  window.open(DOCS_URL + page, '_blank', 'noopener');
}
