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
 * Authenticity: no separately-managed secret. The Outbound Message has
 * "Include Salesforce Session Id" enabled, so the SOAP payload carries a
 * REAL, currently-live Salesforce session — same kind of token as an
 * OAuth access token. We verify it by making one cheap authenticated
 * callout back to that same org with it as a Bearer token; only a
 * genuinely valid, current session passes. The actual resume afterward
 * still goes through Archon's own stored per-org connection
 * (getOrgConnection), not this transient session — this is purely proof
 * the notification really came from this org.
 */
import express, { Router } from 'express';
import { parseStringPromise } from 'xml2js';
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

/** Verify a Session Id is a real, currently-live Salesforce session by using it against the same org. */
async function isLiveSession(sessionId: string, instanceBaseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${instanceBaseUrl}/services/data/v62.0/limits`, {
      headers: { Authorization: `Bearer ${sessionId}` },
    });
    return res.ok;
  } catch {
    return false;
  }
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

    let orgId: string | undefined;
    let recordId: string | undefined;
    let sessionId: string | undefined;
    let enterpriseUrl: string | undefined;
    try {
      const xml = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
      const parsed = await parseStringPromise(xml, { explicitArray: true });
      orgId = findText(parsed, 'OrganizationId');
      sessionId = findText(parsed, 'SessionId');
      enterpriseUrl = findText(parsed, 'EnterpriseUrl') ?? findText(parsed, 'PartnerUrl');
      // The Notification's own Id is a different thing (the notification event's
      // id) — the record under approval is nested one level deeper, inside sObject.
      const sObjectNode = findNode(parsed, 'sObject');
      recordId = sObjectNode ? findText(sObjectNode, 'Id') : undefined;
    } catch (err) {
      logger.error({ err, decision }, 'approval_webhook_xml_parse_failed');
      sendAck(res); // ack anyway — a malformed retry storm helps no one
      return;
    }

    if (!orgId || !recordId || !sessionId || !enterpriseUrl) {
      logger.warn({ orgId, recordId, hasSessionId: !!sessionId, decision }, 'approval_webhook_missing_fields');
      sendAck(res);
      return;
    }

    const instanceBaseUrl = enterpriseUrl.split('/services/')[0];
    if (!(await isLiveSession(sessionId, instanceBaseUrl))) {
      logger.warn({ orgId, decision }, 'approval_webhook_session_invalid');
      res.status(401).end();
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
