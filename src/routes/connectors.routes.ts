/**
 * Connectors API — sessionAuth, org-scoped.
 *
 * The Salesforce MCP tile is no longer a separate OAuth flow — it's derived
 * from OrgInstall. The same SF tokens captured during app Setup are reused
 * as the Bearer when the server hits the standalone Salesforce MCP server.
 *
 * Future connectors (Slack, Drive, etc.) would add real Connector rows; for
 * this phase we ship one virtual connector (`salesforce_mcp`) sourced from
 * OrgInstall.
 */
import { Router } from 'express';
import crypto from 'crypto';
import { logger } from '../logger';
import { config } from '../config';
import { sessionAuth } from '../auth/session';
import { InstallsRepo } from '../db/installs.repo';
import { ConnectorsRepo, PendingOAuthRepo } from '../db/connectors.repo';
import { mcpListTools } from '../mcp/clients/streamable-http-client';
import { refreshAccessToken, buildAuthorizeUrl, exchangeCode, fetchUserInfo, parseUserIdFromIdUrl, brokerRedirectUri as sfBrokerRedirectUri } from '../oauth/salesforce';
import {
  googleConfigured,
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
} from '../oauth/google';
import {
  microsoftConfigured,
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
} from '../oauth/microsoft';
import type { OrgInstall } from '@prisma/client';

export const connectorsRouter = Router();

// ── OAuth broker — provider registry ─────────────────────────────────
// Each provider knows how to build its authorize URL and finish the
// exchange. Adding Outlook later = one more entry here.

interface OAuthProvider {
  configured: () => boolean;
  notConfiguredHint: string;
  authorizeUrl: (state: string) => string;
  finish: (code: string) => Promise<{
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    instanceUrl?: string | null;
    accountEmail?: string | null;
    externalAccountId?: string | null;
  }>;
}

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  // Per-user Salesforce connection — chat tool calls run with THIS user's
  // record access instead of the org-level Archon Setup tokens. Runtime
  // prefers the chatting user's personal connection when one exists.
  salesforce_mcp: {
    configured: () => !!(config.salesforce.mcpClientId && config.salesforce.mcpClientSecret),
    notConfiguredHint: 'Salesforce OAuth is not configured — set SF_MCP_CLIENT_ID and SF_MCP_CLIENT_SECRET in server/.env.',
    authorizeUrl: (state) => buildAuthorizeUrl(state, ['refresh_token', 'api', 'chatter_api', 'id'], sfBrokerRedirectUri()),
    finish: async (code) => {
      const tok = await exchangeCode(code, sfBrokerRedirectUri());
      const who = await fetchUserInfo(tok.instance_url, tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null,
        scopes:            tok.scope ?? null,
        instanceUrl:       tok.instance_url ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.user_id ?? parseUserIdFromIdUrl(tok.id) ?? null,
      };
    },
  },
  outlook: {
    configured: microsoftConfigured,
    notConfiguredHint: 'Outlook OAuth is not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET in server/.env and register the callback URL on the Azure app.',
    authorizeUrl: buildMicrosoftAuthorizeUrl,
    finish: async (code) => {
      const tok = await exchangeMicrosoftCode(code);
      const who = await fetchMicrosoftUserInfo(tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        scopes:            tok.scope ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.id ?? null,
      };
    },
  },
  gmail: {
    configured: googleConfigured,
    notConfiguredHint: 'Gmail OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env and register the callback URL on the Google OAuth client.',
    authorizeUrl: buildGoogleAuthorizeUrl,
    finish: async (code) => {
      const tok = await exchangeGoogleCode(code);
      const who = await fetchGoogleUserInfo(tok.access_token);
      return {
        accessToken:       tok.access_token,
        refreshToken:      tok.refresh_token ?? null,
        tokenExpiresAt:    tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        scopes:            tok.scope ?? null,
        accountEmail:      who.email ?? null,
        externalAccountId: who.id ?? null,
      };
    },
  },
};

// ── POST /api/connectors/oauth/start ─────────────────────────────────
// Called by Apex when a user hits Connect. Returns the provider's
// authorize URL; the LWC navigates the browser there.

connectorsRouter.post('/api/connectors/oauth/start', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const providerKey = String(req.body?.providerKey ?? '');
  const displayName = String(req.body?.displayName ?? providerKey);
  const returnUrl   = String(req.body?.returnUrl ?? '');
  // The SF user starting the flow — connections are PER USER.
  const userId      = String(req.body?.userId ?? '') || null;

  const provider = OAUTH_PROVIDERS[providerKey];
  if (!provider) {
    res.status(400).json({ error: 'unsupported_provider',
      message: `${displayName} is not wired in this build yet. Supported: Salesforce MCP (via Archon Setup), ${Object.keys(OAUTH_PROVIDERS).join(', ')}.` });
    return;
  }
  if (!provider.configured()) {
    res.status(400).json({ error: 'provider_not_configured', message: provider.notConfiguredHint });
    return;
  }
  if (!returnUrl.startsWith('https://') && !returnUrl.startsWith('http://localhost')) {
    res.status(400).json({ error: 'invalid_return_url', message: 'returnUrl must be an https URL.' });
    return;
  }

  try {
    const connector = await ConnectorsRepo.upsertPending({
      orgId, providerKey, displayName, authType: 'OAuth2', configuredBy: userId,
    });
    const state = crypto.randomUUID();
    await PendingOAuthRepo.create({ state, orgId, providerKey, displayName, returnUrl, connectorId: connector.id });
    const authorizeUrl = provider.authorizeUrl(state);
    logger.info({ orgId, providerKey }, 'connector_oauth_started');
    res.json({ connectorId: connector.id, authorizeUrl });
  } catch (err) {
    logger.error({ err, orgId, providerKey }, 'connector_oauth_start_failed');
    res.status(500).json({ error: 'oauth_start_failed', message: (err as Error).message });
  }
});

// ── GET /api/connectors/oauth/callback ───────────────────────────────
// Browser redirect target — NO sessionAuth (the user's browser carries no
// bearer). State ties the callback to the org + connector row.

connectorsRouter.get('/api/connectors/oauth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;

  const pending = state ? await PendingOAuthRepo.consume(state) : null;
  if (!pending) {
    res.status(400).send(callbackPage(false, 'Invalid or expired OAuth state. Close this tab and try Connect again.'));
    return;
  }

  const bounce = (ok: boolean) => {
    try {
      const url = new URL(pending.returnUrl);
      url.searchParams.set('synapse_connected', ok ? '1' : '0');
      if (pending.connectorId) url.searchParams.set('connectorId', pending.connectorId);
      res.redirect(url.toString());
    } catch {
      res.send(callbackPage(ok, ok ? 'Connected. You can close this tab.' : 'Connection failed.'));
    }
  };

  if (error || !code) {
    logger.warn({ error, errorDescription, providerKey: pending.providerKey }, 'connector_oauth_denied');
    if (pending.connectorId) await ConnectorsRepo.markError(pending.connectorId, String(errorDescription ?? error ?? 'denied')).catch(() => null);
    bounce(false);
    return;
  }

  const provider = OAUTH_PROVIDERS[pending.providerKey];
  if (!provider || !pending.connectorId) { bounce(false); return; }

  try {
    const result = await provider.finish(code);
    await ConnectorsRepo.markConnected(pending.connectorId, result);
    logger.info({ orgId: pending.orgId, providerKey: pending.providerKey, accountEmail: result.accountEmail }, 'connector_oauth_connected');
    bounce(true);
  } catch (err) {
    logger.error({ err, providerKey: pending.providerKey }, 'connector_oauth_finish_failed');
    await ConnectorsRepo.markError(pending.connectorId, (err as Error).message).catch(() => null);
    bounce(false);
  }
});

function callbackPage(ok: boolean, message: string): string {
  return `<html><body style="font-family:-apple-system,sans-serif;padding:2rem;text-align:center">
    <h2>${ok ? '✅ Connected' : '❌ Connection failed'}</h2><p>${message}</p></body></html>`;
}

// ── POST /api/mcp-tools ─────────────────────────────────────────────
// Design-time tool catalog proxy. Salesforce owns the MCP server URL
// (ConnectorCatalog__mdt.McpServerUrl__c) and passes it here; we fetch
// the server's public GET /tools and relay it. Keeps the org's Remote
// Site list to just this Node server.

connectorsRouter.post('/api/mcp-tools', sessionAuth, async (req, res) => {
  const url = String(req.body?.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-zA-Z0-9.-]+(:\d+)?$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) {
    res.status(400).json({ error: 'invalid_url', message: 'url must be an https origin (no path).' });
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const r = await fetch(`${url}/tools`, { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) {
      res.status(502).json({ error: 'upstream_error', message: `MCP server returned ${r.status}` });
      return;
    }
    const json = (await r.json()) as { server?: string; tools?: unknown[] };
    res.json({ server: json.server ?? null, tools: json.tools ?? [] });
  } catch (err) {
    logger.warn({ err, url }, 'mcp_tools_proxy_failed');
    res.status(502).json({ error: 'unreachable', message: 'Could not reach the MCP server /tools endpoint.' });
  }
});

// ── GET /api/connectors ──────────────────────────────────────────────
// Returns the per-org connector directory. SF MCP is synthesized from
// OrgInstall; real Connector rows come from the DB.

connectorsRouter.get('/api/connectors', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const install = await InstallsRepo.findByOrgId(orgId);
  const rows    = await ConnectorsRepo.listForOrg(orgId);

  const out: Array<Record<string, unknown>> = [];

  // Synthesize the Salesforce MCP tile from OrgInstall
  if (install) {
    out.push({
      id:               'salesforce_mcp',   // virtual id
      providerKey:      'salesforce_mcp',
      displayName:      'Salesforce MCP',
      status:           'Connected',
      accountEmail:     install.sfUserEmail,
      lastConnectedAt:  install.configuredAt,
      lastErrorMessage: null,
    });
  }

  for (const r of rows) {
    out.push({
      id:               r.id,
      providerKey:      r.providerKey,
      displayName:      r.displayName,
      status:           r.status,
      accountEmail:     r.accountEmail,
      lastConnectedAt:  r.lastConnectedAt,
      lastErrorMessage: r.lastErrorMessage,
    });
  }

  res.json({ connectors: out });
});

// ── DELETE /api/connectors/:id ────────────────────────────────────────

connectorsRouter.delete('/api/connectors/:id', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  if (req.params.id === 'salesforce_mcp') {
    res.status(400).json({ error: 'cannot_delete_setup_connector', message: 'To disconnect Salesforce MCP, reset Synapse Setup.' });
    return;
  }
  try {
    const row = await ConnectorsRepo.disconnect(orgId, req.params.id);
    res.json({ id: row.id, status: row.status });
  } catch (err) {
    res.status(404).json({ error: 'not_found', message: (err as Error).message });
  }
});

// ── GET /api/connectors/:id/tools ─────────────────────────────────────
// Live tools/list from the standalone MCP server.

connectorsRouter.get('/api/connectors/:id/tools', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  if (!config.salesforce.remoteMcpUrl) {
    res.status(500).json({ error: 'remote_mcp_not_configured', message: 'Set SF_REMOTE_MCP_URL in the server .env.' });
    return;
  }

  // The only id we accept right now is `salesforce_mcp` (synthesized)
  if (req.params.id !== 'salesforce_mcp') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const install = await InstallsRepo.findByOrgId(orgId);
  if (!install) {
    res.status(409).json({ error: 'not_configured', message: 'Run Synapse Setup before requesting tools.' });
    return;
  }

  try {
    const fresh = await ensureFreshInstallToken(install);
    const tools = await mcpListTools({
      remoteUrl:   config.salesforce.remoteMcpUrl,
      accessToken: fresh.sfAccessToken,
    });
    res.json({ tools });
  } catch (err) {
    logger.error({ err, orgId }, 'tools_list_failed');
    res.status(502).json({ error: 'tools_list_failed', message: (err as Error).message });
  }
});

/** Refresh the OrgInstall's SF access token if it's expired or close to it. */
async function ensureFreshInstallToken(install: OrgInstall): Promise<OrgInstall> {
  const skewMs = 60_000;
  const stillValid = !install.tokenExpiresAt || install.tokenExpiresAt.getTime() - Date.now() > skewMs;
  if (stillValid) return install;
  if (!install.sfRefreshToken) {
    throw new Error('SF access token expired and no refresh token on file — admin must re-run Synapse Setup.');
  }
  logger.info({ orgId: install.orgId }, 'install_token_refreshing');
  const tok = await refreshAccessToken(install.sfRefreshToken);
  return InstallsRepo.upsert({
    orgId:          install.orgId,
    sessionKey:     install.sessionKey,
    sfAccessToken:  tok.access_token,
    sfRefreshToken: tok.refresh_token ?? install.sfRefreshToken,
    sfInstanceUrl:  tok.instance_url ?? install.sfInstanceUrl,
    sfUserId:       install.sfUserId,
    sfUserEmail:    install.sfUserEmail,
    tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
    scopes:         tok.scope ?? install.scopes,
  });
}
