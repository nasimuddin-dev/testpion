import { AlarmClock, Activity, BookOpenCheck, FolderTree, Bug, FolderGit2, Gauge, GitBranch, History, House, KeyRound, Network, Plug, Radio, ShieldCheck, Sparkles, Waypoints } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ViewId } from '../store';

/**
 * The main navigation, grouped by what you are doing: send requests (per protocol), test and run them, AI, then the
 * workspace's data. Its order is the rail's default order (lib/rail.ts); the request editors are reached through
 * Collections.
 */
export const NAV: Array<{ id: ViewId | 'aiquality'; label: string; icon: ReactNode; group: string; hint?: string }> = [
  { id: 'home', label: 'Home', icon: <House size={18} />, group: 'Start' },
  { id: 'rest', label: 'REST', icon: <Network size={18} />, group: 'Requests', hint: 'REST / HTTP requests' },
  { id: 'graphql', label: 'GraphQL', icon: <GitBranch size={18} />, group: 'Requests' },
  { id: 'grpc', label: 'gRPC', icon: <Waypoints size={18} />, group: 'Requests' },
  { id: 'websocket', label: 'WebSocket', icon: <Radio size={18} />, group: 'Requests', hint: 'WebSocket, Socket.IO, MQTT and Kafka' },
  { id: 'mcp', label: 'MCP', icon: <Plug size={18} />, group: 'Requests', hint: 'MCP servers (inspector)' },
  { id: 'debugger', label: 'Debugger', icon: <Bug size={18} />, group: 'Testing', hint: 'HTTP Debugger: the traffic of other programs through a local proxy' },
  { id: 'tests', label: 'Tests', icon: <ShieldCheck size={18} />, group: 'Testing', hint: 'Test files and runs' },
  { id: 'monitors', label: 'Monitors', icon: <AlarmClock size={18} />, group: 'Testing', hint: 'Scheduled runs' },
  { id: 'load', label: 'Load', icon: <Gauge size={18} />, group: 'Testing', hint: 'Load tests' },
  { id: 'aiquality', label: 'AI quality', icon: <Sparkles size={18} />, group: 'AI', hint: 'Check prompts, chatbots and agents; compare models; set up models and keys' },
  { id: 'rag', label: 'Bots with sources', icon: <BookOpenCheck size={18} />, group: 'AI', hint: 'Bots that answer from your documents (RAG testing): connect one, build questions, check that the answers are backed by the right documents' },
  { id: 'environments', label: 'Environments', icon: <KeyRound size={18} />, group: 'Workspace', hint: 'Environments and variables' },
  { id: 'history', label: 'History', icon: <History size={18} />, group: 'Workspace', hint: 'What you sent, with the response (send it again)' },
  { id: 'traces', label: 'Traces', icon: <Activity size={18} />, group: 'Workspace', hint: 'Timing waterfall of each send and run step' },
  { id: 'git', label: 'Git', icon: <FolderGit2 size={18} />, group: 'Workspace', hint: 'Git: changes, commit, branches, pull and push' },
];

/** The rail's Collections item: every request editor (REST, GraphQL, gRPC, WebSocket, MCP) with the explorer as its sidebar. */
export const COLLECTIONS_NAV: { id: 'collections'; label: string; icon: ReactNode; group: string; hint: string } = {
  id: 'collections',
  label: 'Collections',
  icon: <FolderTree size={18} />,
  group: 'Start',
  hint: 'Collections: requests of every kind (REST, GraphQL, gRPC, WebSocket, MCP)',
};
