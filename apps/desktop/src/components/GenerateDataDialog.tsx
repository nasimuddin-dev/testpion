import { lazy, Suspense, type ComponentProps } from 'react';
export type { GeneratedData } from './GenerateDataDialogBody';

// The test data generator: loads when first opened, not at startup
const GenerateDataDialogBody = lazy(async () => ({ default: (await import('./GenerateDataDialogBody')).GenerateDataDialogBody }));

export function GenerateDataDialog(props: ComponentProps<typeof GenerateDataDialogBody>) {
  return (
    <Suspense fallback={null}>
      <GenerateDataDialogBody {...props} />
    </Suspense>
  );
}
