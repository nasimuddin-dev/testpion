import type { ReactNode } from 'react';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';

/**
 * The down arrow of the environment tables (the matrix of every variable in every environment, and two environments
 * compared): one bar for both, so each saves the same CSV, Markdown and JSON. Only statuses and masked values are in them.
 */
export function EnvOutputBar({ spec, children }: { spec: OutputSpec; children?: ReactNode }) {
  return (
    <div className="flex items-center ml-auto min-w-0" data-output="env.matrix">
      <OutputActions spec={spec}>{children}</OutputActions>
    </div>
  );
}
