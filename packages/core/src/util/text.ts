/** The text with CRLF (and lone CR) line ends as LF: the one spelling of the normalisation the parsers, diffs and serializers share. */
export const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');
