/**
 * The kinds of call the app sends and records (a History entry, a trace, a console line, a row of the activity or run charts):
 * one name each, the same in every view (B5). These are protocols, not item kinds: an item's kind and its name are
 * KIND_INFO's (@testpion/shared). `filter` is what a Kind filter lists it as.
 */
export const TRAFFIC_KIND: Readonly<Record<string, { label: string; filter: string; tone: 'default' | 'accent' | 'judge' }>> = {
  http: { label: 'HTTP', filter: 'HTTP', tone: 'default' },
  graphql: { label: 'GraphQL', filter: 'GraphQL', tone: 'accent' },
  grpc: { label: 'gRPC', filter: 'gRPC', tone: 'default' },
  mcp: { label: 'MCP', filter: 'MCP', tone: 'judge' },
  llm: { label: 'AI', filter: 'AI', tone: 'judge' },
  websocket: { label: 'WebSocket', filter: 'WebSocket', tone: 'judge' },
  capture: { label: 'Capture session', filter: 'Capture sessions', tone: 'default' },
  test: { label: 'Test', filter: 'Tests', tone: 'default' },
  // the types of a run's tests (a run's charts)
  script: { label: 'Script', filter: 'Scripts', tone: 'default' },
  evaluation: { label: 'Evaluation', filter: 'Evaluations', tone: 'default' },
  rag: { label: 'RAG', filter: 'RAG', tone: 'judge' },
  agent: { label: 'Agent', filter: 'Agents', tone: 'judge' },
};

/** The name of a kind of call ('graphql' → GraphQL); an unknown one as it is. */
export const trafficKindLabel = (kind: string): string => TRAFFIC_KIND[kind]?.label ?? kind;

/** A Kind filter's options for these kinds (the empty value is "All kinds", drawn by the filter). */
export const trafficKindOptions = (kinds: readonly string[]): Array<{ id: string; label: string }> => kinds.map((id) => ({ id, label: TRAFFIC_KIND[id]?.filter ?? id }));
