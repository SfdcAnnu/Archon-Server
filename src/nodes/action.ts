import { register } from './registry';
import type { NodeExecutor } from './registry';
import { logger } from '../logger';

/**
 * Salesforce CRM action nodes — get/update/create record, run SOQL,
 * create task, post chatter.
 *
 * Multi-tenant: every call runs through `ctx.conn` (getOrgConnection for
 * the triggering org — see orchestrator/context.ts), NOT the shared
 * bootstrap "Run As" user. A Lead-scoring agent installed in customer A's
 * org must never touch customer B's data because both happened to hit the
 * same Node process.
 */

const getRecord: NodeExecutor = async (node, ctx) => {
  const objectType = String(node.config.objectType ?? '');
  const fields = String(node.config.fields ?? 'Id,Name')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const rec = await ctx.conn.sobject(objectType).retrieve(ctx.recordId, fields as never);
    return {
      nodeId: node.id,
      nodeSubType: 'get_record',
      success: true,
      output: rec as Record<string, unknown>,
      toolsUsed: ['salesforce-crm:get_record'],
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id, orgId: ctx.orgId }, 'get_record_failed');
    return { nodeId: node.id, nodeSubType: 'get_record', success: false, error: (err as Error).message };
  }
};

const updateRecord: NodeExecutor = async (node, ctx) => {
  const objectType = String(node.config.objectType ?? '');
  const rawMappings = String(node.config.fieldMappings ?? '{}');
  let mappings: Record<string, unknown>;
  try {
    mappings = JSON.parse(ctx.interpolate(rawMappings));
  } catch {
    return { nodeId: node.id, nodeSubType: 'update_record', success: false, error: 'fieldMappings is not valid JSON' };
  }

  try {
    const res = await ctx.conn.sobject(objectType).update({ Id: ctx.recordId, ...mappings } as never);
    logger.info({ objectType, orgId: ctx.orgId, id: ctx.recordId }, 'sf_update_org_scoped');
    return {
      nodeId: node.id,
      nodeSubType: 'update_record',
      success: true,
      output: res as unknown as Record<string, unknown>,
      toolsUsed: ['salesforce-crm:update_record'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'update_record', success: false, error: (err as Error).message };
  }
};

const createRecord: NodeExecutor = async (node, ctx) => {
  const objectType = String(node.config.objectType ?? 'Task');
  const rawMappings = String(node.config.fieldMappings ?? '{}');
  let mappings: Record<string, unknown>;
  try {
    mappings = JSON.parse(ctx.interpolate(rawMappings));
  } catch {
    return { nodeId: node.id, nodeSubType: 'create_record', success: false, error: 'fieldMappings is not valid JSON' };
  }

  try {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mappings)) if (v !== undefined) cleaned[k] = v;
    const res = await ctx.conn.sobject(objectType).create(cleaned as never);
    logger.info({ objectType, orgId: ctx.orgId }, 'sf_create_org_scoped');
    return {
      nodeId: node.id,
      nodeSubType: 'create_record',
      success: true,
      output: res as unknown as Record<string, unknown>,
      toolsUsed: ['salesforce-crm:create_record'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'create_record', success: false, error: (err as Error).message };
  }
};

const queryRecords: NodeExecutor = async (node, ctx) => {
  const soql = ctx.interpolate(String(node.config.soql ?? ''));
  if (!soql) {
    return { nodeId: node.id, nodeSubType: 'query_records', success: false, error: 'soql is empty' };
  }
  try {
    const res = await ctx.conn.query<Record<string, unknown>>(soql);
    return {
      nodeId: node.id,
      nodeSubType: 'query_records',
      success: true,
      output: { records: res.records, count: res.records.length },
      toolsUsed: ['salesforce-crm:query'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'query_records', success: false, error: (err as Error).message };
  }
};

const createTask: NodeExecutor = async (node, ctx) => {
  const subject = ctx.interpolate(String(node.config.subject ?? 'AI-generated task'));
  const dueDate = String(node.config.dueDate ?? 'TODAY+1');
  const priority = String(node.config.priority ?? 'Normal');

  const due = parseRelativeDate(dueDate);
  const isPersonId = ctx.recordId.startsWith('00Q') || ctx.recordId.startsWith('003');
  const fields: Record<string, unknown> = {
    Subject: subject,
    Priority: priority,
    Status: 'Not Started',
    WhoId: isPersonId ? ctx.recordId : undefined,
    WhatId: !isPersonId ? ctx.recordId : undefined,
    ActivityDate: due,
  };
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) cleaned[k] = v;

  try {
    const res = await ctx.conn.sobject('Task').create(cleaned as never);
    return {
      nodeId: node.id,
      nodeSubType: 'create_task',
      success: true,
      output: res as unknown as Record<string, unknown>,
      toolsUsed: ['salesforce-crm:create_task'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'create_task', success: false, error: (err as Error).message };
  }
};

const postChatter: NodeExecutor = async (node, ctx) => {
  const message = ctx.interpolate(String(node.config.message ?? ''));
  try {
    const res = await ctx.conn.sobject('FeedItem').create({
      ParentId: ctx.recordId,
      Body: message,
    } as never);
    return {
      nodeId: node.id,
      nodeSubType: 'post_chatter',
      success: true,
      output: res as unknown as Record<string, unknown>,
      toolsUsed: ['salesforce-crm:post_chatter'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'post_chatter', success: false, error: (err as Error).message };
  }
};

register('get_record', getRecord);
register('update_record', updateRecord);
register('create_record', createRecord);
register('query_records', queryRecords);
register('create_task', createTask);
register('post_chatter', postChatter);

// Apex action — placeholder (org-scoped invocable-action wiring is a follow-up)
register('apex_action', async (node) => ({
  nodeId: node.id,
  nodeSubType: 'apex_action',
  success: false,
  error: 'Apex invocable callback not yet wired',
}));

function parseRelativeDate(spec: string): string {
  // 'TODAY' | 'TODAY+N' | 'TODAY-N' | ISO date
  const m = spec.match(/^TODAY([+-]\d+)?$/);
  if (m) {
    const days = m[1] ? Number(m[1]) : 0;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  return spec;
}
