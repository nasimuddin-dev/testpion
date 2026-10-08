import { useMemo, type HTMLAttributes } from 'react';
import { highlight, type CodeLanguage } from '../lib/highlight';

/**
 * Read-only code with syntax colours (the editor theme's, via styles.css `.syn-*`): payloads, schemas, configs,
 * raw HTTP. The language is detected when not given; plain text stays plain. The one way to show code that is not
 * edited, everywhere in the app.
 */
export function CodeBlock({ text, language, ...rest }: { text: string; language?: CodeLanguage } & HTMLAttributes<HTMLPreElement>) {
  const tokens = useMemo(() => highlight(text, language), [text, language]);
  return (
    <pre {...rest}>
      {tokens.map((t, i) =>
        t.kind ? (
          <span key={i} className={`syn-${t.kind}`}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </pre>
  );
}
