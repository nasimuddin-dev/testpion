import { Braces, Eye, FileCheck2, GitCompare, ListChecks, Play, Plug, ScanSearch, Sparkles, SquareArrowOutUpRight, Unplug, Wand2, Workflow } from 'lucide-react';
import type { ActionDef } from '../node-menu-actions';
import { LABEL } from '../vocabulary';

/** The actions of the explorer's workspace kinds: MCP servers, API definitions, datasets, and their sections. */
export const EXPLORER_ACTIONS: readonly ActionDef[] = [
  // MCP servers
  { id: 'connect', group: 'run', label: LABEL.connect, icon: Plug, kinds: ['mcp-server'] },
  { id: 'disconnect', group: 'run', label: LABEL.disconnect, icon: Unplug, kinds: ['mcp-server'] },
  { id: 'copyMcpConfig', group: 'share', label: LABEL.copyMcpConfig, icon: Braces, kinds: ['mcp-server'] },
  { id: 'openMcpInspector', group: 'open', label: LABEL.openMcpInspector, icon: SquareArrowOutUpRight, kinds: ['section:mcp-server'] },
  // API definitions
  { id: 'lint', group: 'run', label: LABEL.lint, icon: ListChecks, kinds: ['spec'] },
  { id: 'apiCoverage', group: 'run', label: LABEL.apiCoverage, icon: ScanSearch, kinds: ['spec'] },
  { id: 'compareVersions', group: 'run', label: LABEL.compareVersions, icon: GitCompare, kinds: ['spec'] },
  { id: 'generateTests', group: 'tools', label: LABEL.generateTests, icon: FileCheck2, kinds: ['spec'] },
  { id: 'generateFlows', group: 'tools', label: LABEL.generateFlows, icon: Workflow, kinds: ['spec'] },
  { id: 'openApiDefinitions', group: 'open', label: LABEL.openApiDefinitions, icon: SquareArrowOutUpRight, kinds: ['section:spec'] },
  // datasets
  { id: 'preview', group: 'open', label: LABEL.preview, icon: Eye, kinds: ['dataset'] },
  { id: 'runWithDataset', group: 'run', label: LABEL.runWithDataset, icon: Play, kinds: ['dataset'] },
  { id: 'useInTest', group: 'tools', label: LABEL.useInTest, icon: Wand2, kinds: ['dataset'] },
  { id: 'generateData', group: 'create', label: LABEL.generateData, icon: Sparkles, kinds: ['section:dataset'] },
];
