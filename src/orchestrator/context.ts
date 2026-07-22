import type { Connection } from 'jsforce';
import type { AgentDefinition, AgentNode, NodeResult } from '../types';
import type { GraphAdjacency } from './graph';

/**
 * ExecutionContext threads state through the graph walk.
 *
 * - `state` maps node IDs to their outputs so later nodes can reference earlier ones
 *   via `{!nodeId.field}` or canonical aliases like `{!ai.score}`, `{!record.Email}`.
 * - `aliases` is a flat name lookup (e.g. 'ai' → latest AI node id, 'record' → trigger output).
 * - `graph` is the parsed adjacency map — AI orchestrator executors read it to find
 *   their downstream tool catalog nodes.
 * - `consumedCatalogIds` tracks tool catalog nodes that have been absorbed by an AI
 *   orchestrator so the engine doesn't re-execute them as separate BFS steps.
 */
export class ExecutionContext {
  readonly correlationId: string;
  readonly agent: AgentDefinition;
  readonly recordId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly inputPayload: Record<string, unknown>;
  /** Per-org Salesforce connection (getOrgConnection) — action nodes read/write
   *  through THIS, never a single shared bootstrap user. Multi-tenancy boundary. */
  readonly conn: Connection;
  readonly state = new Map<string, Record<string, unknown>>();
  readonly toolsUsed = new Set<string>();
  readonly consumedCatalogIds = new Set<string>();
  graph!: GraphAdjacency;
  private aliases = new Map<string, string>();

  constructor(args: {
    correlationId: string;
    agent: AgentDefinition;
    recordId: string;
    orgId: string;
    userId: string;
    inputPayload: Record<string, unknown>;
    conn: Connection;
  }) {
    this.correlationId = args.correlationId;
    this.agent = args.agent;
    this.recordId = args.recordId;
    this.orgId = args.orgId;
    this.userId = args.userId;
    this.inputPayload = args.inputPayload;
    this.conn = args.conn;
  }

  /**
   * Returns downstream nodes from `fromNodeId` that are tool catalogs.
   * Marks them as consumed so the engine BFS skips them.
   * Used by AI orchestrator executors to discover their attached tool catalogs.
   */
  consumeDownstreamCatalogs(fromNodeId: string): AgentNode[] {
    if (!this.graph) return [];
    const portMap = this.graph.nextByPort.get(fromNodeId);
    if (!portMap) return [];
    const consumed: AgentNode[] = [];
    for (const ids of portMap.values()) {
      for (const id of ids) {
        const n = this.graph.byId.get(id);
        if (n && n.nodeType === 'catalog') {
          this.consumedCatalogIds.add(n.id);
          consumed.push(n);
        }
      }
    }
    return consumed;
  }

  recordResult(node: { id: string; nodeType: string }, result: NodeResult): void {
    if (result.output) this.state.set(node.id, result.output);
    // Latest node of each type becomes the canonical alias.
    this.aliases.set(node.nodeType, node.id);
    if (result.toolsUsed) result.toolsUsed.forEach((t) => this.toolsUsed.add(t));
  }

  /** Look up a value via `{!alias.field}` or `{!nodeId.field}` syntax. */
  resolve(path: string): unknown {
    const [head, ...rest] = path.split('.');
    const nodeId = this.aliases.get(head) ?? head;

    // Special roots
    if (head === 'recordId') return this.recordId;
    if (head === 'input') return this.getDeep(this.inputPayload, rest);
    if (head === 'record') {
      // alias for trigger node output
      const triggerId = this.aliases.get('trigger');
      const triggerOut = triggerId ? this.state.get(triggerId) : undefined;
      return this.getDeep(triggerOut ?? {}, rest);
    }

    const node = this.state.get(nodeId);
    if (!node) return undefined;
    return this.getDeep(node, rest);
  }

  private getDeep(obj: Record<string, unknown>, path: string[]): unknown {
    let cur: unknown = obj;
    for (const p of path) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  /**
   * Interpolate `{!path.to.value}` placeholders in a template string.
   * Used by nodes that render dynamic config (e.g. email body, SOQL where clause).
   */
  interpolate(template: string): string {
    if (!template) return template;
    return template.replace(/\{!([^}]+)\}/g, (_match, path: string) => {
      const v = this.resolve(path.trim());
      return v == null ? '' : String(v);
    });
  }
}
