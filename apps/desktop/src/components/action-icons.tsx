import {
  AlertOctagon,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpToLine,
  BookOpen,
  Bot,
  Check,
  ClipboardPaste,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  FlaskConical,
  FolderOpen,
  GitCommitHorizontal,
  GitMerge,
  HelpCircle,
  History,
  KeyRound,
  Layers,
  Link,
  ListChecks,
  LogIn,
  LogOut,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scale,
  Search,
  Send,
  Settings,
  Share2,
  Sparkles,
  Square,
  Star,
  Trash2,
  Unplug,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { isValidElement, type ReactNode } from 'react';

/**
 * One icon per action, everywhere (owner, 2026-10-06: "use proper icon everywhere its possible because user can
 * understand the icon"). A button or a menu row without an icon of its own gets the one its label names; the same
 * verb shows the same picture in every view. Order matters: the first verb that matches wins.
 */
const RULES: Array<[RegExp, (size: number) => ReactNode]> = [
  [/^(cancel|close|not now|later|no\b|dismiss|abort)/, (s) => <X size={s} />],
  [/^(delete|remove|empty|discard|clear|forget|uninstall)/, (s) => <Trash2 size={s} />],
  [/^(create|add|new|initiali[sz]e|init)\b/, (s) => <Plus size={s} />],
  [/^(save|keep mine)/, (s) => <Save size={s} />],
  [/^(rename|edit|change|bulk edit)\b/, (s) => <Pencil size={s} />],
  [/^(paste)\b/, (s) => <ClipboardPaste size={s} />],
  [/^(copy|duplicate|clone)\b/, (s) => <Copy size={s} />],
  [/^(import|upload|choose file|attach|load file|load from)\b/, (s) => <Upload size={s} />],
  [/^(export|download)\b/, (s) => <Download size={s} />],
  [/^(choose|pick|browse|open folder|reveal)\b/, (s) => <FolderOpen size={s} />],
  [/^(open|go to|view|show in|launch)\b/, (s) => <ExternalLink size={s} />],
  [/^(hide)\b/, (s) => <EyeOff size={s} />],
  [/^(show|preview|reveal)\b/, (s) => <Eye size={s} />],
  [/^(send|respond|reply|submit)\b/, (s) => <Send size={s} />],
  [/^(run|start|resume|continue|try again|retry|play)\b/, (s) => <Play size={s} />],
  [/^(stop)\b/, (s) => <Square size={s} />],
  [/^(pause)\b/, (s) => <Pause size={s} />],
  [/^(test)\b/, (s) => <FlaskConical size={s} />],
  [/^(refresh|reload|check for update|sync|update|install|regenerate|renew)/, (s) => <RefreshCw size={s} />],
  [/^(reset|restore|undo|revert|roll back)\b/, (s) => <RotateCcw size={s} />],
  [/^(connect|always|reconnect)\b/, (s) => <Plug size={s} />],
  [/^(disconnect)\b/, (s) => <Unplug size={s} />],
  [/^(move|replace|switch|take theirs|swap)\b/, (s) => <ArrowRightLeft size={s} />],
  [/^(compare|diff)\b/, (s) => <Scale size={s} />],
  [/^(commit)\b/, (s) => <GitCommitHorizontal size={s} />],
  [/^(merge|abort merge)\b/, (s) => <GitMerge size={s} />],
  [/^(push|publish)\b/, (s) => <ArrowUpToLine size={s} />],
  [/^(pull|fetch)\b/, (s) => <ArrowDownToLine size={s} />],
  [/^(all )?(history|recent)\b/, (s) => <History size={s} />],
  [/^(search|find|introspect|look up)\b/, (s) => <Search size={s} />],
  [/^(filter)\b/, (s) => <Filter size={s} />],
  [/^(read|learn|docs|documentation|guide)\b/, (s) => <BookOpen size={s} />],
  [/^(help|what is)\b/, (s) => <HelpCircle size={s} />],
  [/^(ask|explain)\b/, (s) => <Bot size={s} />],
  [/^(generate|suggest|write with ai|ai\b)/, (s) => <Sparkles size={s} />],
  [/^(fix|repair|format|beautify|tidy)\b/, (s) => <Wand2 size={s} />],
  [/^(sign in|log in|login)\b/, (s) => <LogIn size={s} />],
  [/^(sign out|log out|logout)\b/, (s) => <LogOut size={s} />],
  [/^(share)\b/, (s) => <Share2 size={s} />],
  [/^(link)\b/, (s) => <Link size={s} />],
  [/^(set up|setup|configure|settings|preferences|open providers|providers|manage)\b/, (s) => <Settings size={s} />],
  [/^(key|api key|password|token|secret)\b/, (s) => <KeyRound size={s} />],
  [/^(profiles?|presets?)\b/, (s) => <Layers size={s} />],
  [/^(select all|select none)\b/, (s) => <ListChecks size={s} />],
  [/^(bookmark|star|favou?rite)\b/, (s) => <Star size={s} />],
  [/^(code|snippet|curl)\b/, (s) => <Code2 size={s} />],
  [/^(back|previous)\b/, (s) => <ArrowLeft size={s} />],
  [/^(next|forward)\b/, (s) => <ArrowRight size={s} />],
  [/^(done|ok|apply|accept|confirm|yes|use|allow|trust|keep)\b/, (s) => <Check size={s} />],
];

/** The icon an action's label names, or undefined when no verb matches (and no fallback is asked for). */
export function iconForLabel(label: string, variant?: string, opts: { size?: number; fallback?: boolean } = {}): ReactNode {
  const size = opts.size ?? 13;
  const l = label.trim().toLowerCase();
  if (!l) return undefined;
  for (const [re, icon] of RULES) if (re.test(l)) return icon(size);
  if (opts.fallback === false) return undefined;
  if (variant === 'danger') return <AlertOctagon size={size} />;
  return <Check size={size} />;
}

/** The plain text of a button's children ("Save", ["Run ", count]); empty when it is only an icon or markup. */
export function textOf(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (isValidElement(children)) return textOf((children.props as { children?: ReactNode }).children);
  return '';
}
