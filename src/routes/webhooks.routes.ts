/**
 * Native-Approval-Process decision receiver.
 *
 * Salesforce's own Outbound Message — configured as the Final Approval
 * Action / Final Rejection Action on whichever Approval Process an admin
 * points at an Archon agent — POSTs a SOAP "notification" the instant a
 * human decides, no polling needed. Two Outbound Messages are packaged
 * (ArchonApprovalApproved / ArchonApprovalRejected), one per URL below, so
 * the decision is encoded in which endpoint fired rather than the payload.
 *
 * Outbound Messages can't send Archon's own bearer session token, so this
 * route uses Basic Auth against a shared secret instead of `sessionAuth`
 * (see config.salesforce.outboundWebhookSecret / SynapseConfig__mdt).
 */
import express, { Router } from 'express';
import { parseStringPromise } from 'xml2js';
import { config } from '../config';
import { logger } from '../logger';
import { resumeRunById } from '../orchestrator/engine';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { RunsRepo } from '../db/runs.repo';
import { schedulePlatformEvent } from '../salesforce/callback';

export const webhooksRouter = Router();

const SOAP_ACK = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack></notificationsResponse></soapenv:Body>
</soapenv:Envelope>`;

function sendAck(res: express.Response): void {
  res.status(200).type('text/xml').send(SOAP_ACK);
}

type XmlNode = Record<string, unknown>;

/** First object anywhere in the (xml2js explicitArray) tree whose tag matches, ignoring namespace prefix (e.g. "sf:Id" vs "Id"). */
function findNode(obj: unknown, tag: string): XmlNode | undefined {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findNode(item, tag);
      if (found) return found;
    }
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  for (const [key, value] of Object.entries(obj as XmlNode)) {
    const bareKey = key.includes(':') ? key.split(':')[1] : key;
    if (bareKey === tag) return { [key]: value };
  }
  for (const value of Object.values(obj as XmlNode)) {
    const found = findNode(value, tag);
    if (found) return found;
  }
  return undefined;
}

/** Text content of the first matching tag (xml2js explicitArray wraps every value in a 1-element array). */
function findText(obj: unknown, tag: string): string | undefined {
  const node = findNode(obj, tag);
  if (!node) return undefined;
  const value = Object.values(node)[0];
  const unwrapped = Array.isArray(value) ? value[0] : value;
  if (typeof unwrapped === 'string') return unwrapped;
  // Text nodes sometimes land under a "_" key when the element also has attributes.
  if (unwrapped && typeof unwrapped === 'object' && typeof (unwrapped as XmlNode)._ === 'string') {
    return (unwrapped as XmlNode)._ as string;
  }
  return undefined;
}

webhooksRouter.post(
  '/api/webhooks/approval-decision/:decision',
  // Outbound Messages send text/xml — the app-level express.json() body
  // parser only handles application/json, so this route parses its own raw
  // body regardless of Content-Type.
  express.raw({ type: () => true, limit: '2mb' }),
  async (req, res) => {
    const decision = req.params.decision === 'approved' || req.params.decision === 'rejected'
      ? req.params.decision : null;
    if (!decision) {
      res.status(404).json({ error: 'unknown_decision' });
      return;
    }

    const auth = req.header('authorization') ?? '';
    const expected = config.salesforce.outboundWebhookSecret;
    if (!expected || !isValidBasicAuth(auth, expected)) {
      logger.warn({ decision }, 'approval_webhook_unauthorized');
      res.status(401).end();
      return;
    }

    let orgId: string | undefined;
    let recordId: string | undefined;
    try {
      const xml = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const parsed = await parseStringPromise(xml, { explicitArray: true });
      orgId = findText(parsed, 'OrganizationId');
      // The Notification's own Id is a different thing (the notification event's
      // id) — the record under approval is nested one level deeper, inside sObject.
      const sObjectNode = findNode(parsed, 'sObject');
      recordId = sObjectNode ? findText(sObjectNode, 'Id') : undefined;
    } catch (err) {
      logger.error({ err, decision }, 'approval_webhook_xml_parse_failed');
      sendAck(res); // ack anyway — a malformed retry storm helps no one
      return;
    }

    if (!orgId || !recordId) {
      logger.warn({ orgId, recordId, decision }, 'approval_webhook_missing_fields');
      sendAck(res);
      return;
    }

    try {
      const run = await RunsRepo.getPendingApprovalByRecord(orgId, recordId);
      if (!run) {
        logger.warn({ orgId, recordId, decision }, 'approval_webhook_no_matching_run');
        sendAck(res);
        return;
      }
      const conn = await getOrgConnection(run.orgId);
      const agent = await AgentCache.load(run.orgId, run.agentApiName, conn);
      if (!agent) {
        logger.error({ orgId: run.orgId, agentApiName: run.agentApiName }, 'approval_webhook_agent_not_found');
        sendAck(res);
        return;
      }
      const result = await resumeRunById({ orgId: run.orgId, runId: run.id, agent, conn, decision });
      schedulePlatformEvent({
        orgId: run.orgId, agentApiName: run.agentApiName, recordId: run.recordId ?? '', result,
      }).catch((err) => logger.error({ err, runId: run.id }, 'approval_webhook_platform_event_failed'));
      logger.info({ runId: run.id, decision, agentStatus: result.agentStatus }, 'approval_webhook_resumed');
    } catch (err) {
      logger.error({ err, orgId, recordId, decision }, 'approval_webhook_resume_failed');
    }
    sendAck(res);
  },
);

function isValidBasicAuth(header: string, expectedPassword: string): boolean {
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    return password === expectedPassword;
  } catch {
    return false;
  }
}
