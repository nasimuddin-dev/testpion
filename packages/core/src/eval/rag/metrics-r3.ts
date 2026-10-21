/**
 * The metrics of the third release (planning/rag-testing.md R3): multimodal, conversational, agent and tool use, judged
 * safety, and the judge designs that needed their own (g-eval, dag, pairwise, summarization, classifier and reward models).
 * Each family is a pair of modules (the checks, then the catalogue rows) loaded here so `metrics.ts` stays the one list of
 * what exists.
 */
import './metrics-multimodal.js';
import './metric-defs-multimodal.js';
import './metrics-conversation.js';
import './metric-defs-conversation.js';
import './metrics-agent.js';
import './metric-defs-agent.js';
import './metrics-safety.js';
import './metric-defs-safety.js';
import './metrics-extra.js';
import './dag.js';
import './metrics-endpoint.js';
import './metric-defs-extra.js';
import './metrics-format.js';
import './metric-defs-format.js';
