import { register } from './registry';
import { sfGetRecord, sfUpdateRecord, sfCreateRecord, sfQuery } from '../mcp/servers/salesforce-crm';
import type { NodeExecutor } from './registry';
import { logger } from '../logger';

/**
 * Salesforce CRM action nodes — get/update/create record, run SOQL,
 * create task, post chatter. All routed through the salesforce-crm MCP.
 */

const getRecord: NodeExecutor = async (node, ctx) => {
  const objectType = String(node.config.objectType ?? '');
  const fields = String(node.config.fields ?? 'Id,Name')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const rec = await sfGetRecord({ objectType, recordId: ctx.recordId, fields });
    return {
      nodeId: node.id,
      nodeSubType: 'get_record',
      success: true,
      output: rec,
      toolsUsed: ['salesforce-crm:get_record'],
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id }, 'get_record_failed');
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
    const res = await sfUpdateRecord({ objectType, recordId: ctx.recordId, fields: mappings });
    return {
      nodeId: node.id,
      nodeSubType: 'update_record',
      success: true,
      output: res,
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
    const res = await sfCreateRecord({ objectType, fields: mappings });
    return {
      nodeId: node.id,
      nodeSubType: 'create_record',
      success: true,
      output: res,
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
    const res = await sfQuery({ soql });
    return {
      nodeId: node.id,
      nodeSubType: 'query_records',
      success: true,
      output: { records: res, count: res.length },
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
  const fields: Record<string, unknown> = {
    Subject: subject,
    Priority: priority,
    Status: 'Not Started',
    WhoId: ctx.recordId.startsWith('00Q') || ctx.recordId.startsWith('003') ? ctx.recordId : undefined,
    WhatId: !(ctx.recordId.startsWith('00Q') || ctx.recordId.startsWith('003')) ? ctx.recordId : undefined,
    ActivityDate: due,
  };

  try {
    const res = await sfCreateRecord({ objectType: 'Task', fields });
    return {
      nodeId: node.id,
      nodeSubType: 'create_task',
      success: true,
      output: res,
      toolsUsed: ['salesforce-crm:create_task'],
    };
  } catch (err) {
    return { nodeId: node.id, nodeSubType: 'create_task', success: false, error: (err as Error).message };
  }
};

const postChatter: NodeExecutor = async (node, ctx) => {
  const message = ctx.interpolate(String(node.config.message ?? ''));
  try {
    const res = await sfCreateRecord({
      objectType: 'FeedItem',
      fields: { ParentId: ctx.recordId, Body: message },
    });
    return {
      nodeId: node.id,
      nodeSubType: 'post_chatter',
      success: true,
      output: res,
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

// Apex action — placeholder
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
