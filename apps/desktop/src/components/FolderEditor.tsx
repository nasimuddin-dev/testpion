import { lazy, Suspense, type ComponentProps } from 'react';

// Folder settings (scripts, variables, auth): loads when first opened, not at startup
const FolderEditorBody = lazy(async () => ({ default: (await import('./FolderEditorBody')).FolderEditorBody }));

export function FolderEditor(props: ComponentProps<typeof FolderEditorBody>) {
  return (
    <Suspense fallback={null}>
      <FolderEditorBody {...props} />
    </Suspense>
  );
}
