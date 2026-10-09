import { lazy, Suspense, type ComponentProps } from 'react';

// The export dialog: loads when first opened, not at startup
const ExportDialogBody = lazy(async () => ({ default: (await import('./ExportDialogBody')).ExportDialogBody }));

export function ExportDialog(props: ComponentProps<typeof ExportDialogBody>) {
  return (
    <Suspense fallback={null}>
      <ExportDialogBody {...props} />
    </Suspense>
  );
}
