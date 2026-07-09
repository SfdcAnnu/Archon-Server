# Synapse AI — Execution Server

Node.js + TypeScript server that runs Synapse AI agent graphs. Salesforce stores config and audit; this server does all AI inference and MCP tool execution so Apex stays inside governor limits.

## Architecture

```
   Salesforce org                                Synapse AI server (this repo)
 ┌───────────────────┐    JWT-signed HTTPS    ┌─────────────────────────────┐
 │ AgentBuilder UI   │  ────────────────────▶ │ POST /agent/execute         │
 │ AgentRunner.cls   │     Named Credential   │   ├ verify JWT              │
 │ Trigger handlers  │     "Agent_Platform"   │   ├ load AgentDefinition    │
 │                   │ ◀── Platform Event ─── │   ├ walk graph              │
 │ AgentExecution__c │   AgentExecutionResult │   ├ exec nodes              │
 └───────────────────┘                        │   │   ├ claude (ai-models)  │
                                              │   │   ├ get/update record  │
                                              │   │   └ if/else, loop ...  │
                                              │   └ publish result event   │
                                              └─────────────────────────────┘
```

## Prerequisites

- **Node.js ≥ 20** (the SDK and `tsx` need modern Node)
- **A Salesforce dev/sandbox org** with the Synapse AI metadata deployed
- **An Anthropic API key** (`sk-ant-...`)
- **ngrok** (or any tunneling tool) for local dev, OR a public host (Heroku, Fly.io, AWS Lambda + API Gateway, etc.) for production
- **`openssl`** for generating the JWT secret and SF Connected App cert

## 1. Install

```bash
cd server
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Generate a JWT secret:

```bash
openssl rand -hex 32
# paste the output as JWT_SECRET in .env
```

Set `ANTHROPIC_API_KEY` to your key from `https://console.anthropic.com/`.

The Salesforce values (`SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY_PATH`) come from step 4.

## 3. Run the server

Dev mode (auto-reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

You should see `synapse_ai_server_started` in the log and `GET /health` returning `{"status":"ok"}`.

## 4. Wire Salesforce → server

### 4a. Expose the server publicly (dev)

```bash
ngrok http 3000
# → https://abc123.ngrok-free.app
```

In Setup → **Named Credentials** → `Agent Platform`:
- **Endpoint**: paste the ngrok URL (no trailing slash)
- **Save**

### 4b. Make Salesforce sign requests with your JWT secret

Salesforce's Named Credential alone can send an unsigned bearer header. To get HMAC-signed JWTs that this server can verify, customers usually:

**Option A — Use an External Credential (recommended for production)**

1. Setup → **External Credentials** → New
2. Authentication Protocol: **Custom**
3. Authentication Parameters: add `JwtSecret` = the same hex string in `JWT_SECRET`
4. Link the External Credential to the `Agent_Platform` Named Credential
5. Write a small `HttpCalloutAction` Apex class (or use Flow HTTP Callouts) that mints a JWT in Apex using `Crypto.generateMac('HmacSHA256', ...)` and sets `Authorization: Bearer <jwt>` on the request

**Option B — Quick dev shortcut**

In `AgentBuilderController.executeAgent` and `AgentRunner.callExternalEngine`, sign the JWT inline before the callout:

```apex
String jwt = mintHs256Jwt(new Map<String,Object>{
    'orgId' => UserInfo.getOrganizationId(),
    'userId' => UserInfo.getUserId(),
    'agentApiName' => agentApiName,
    'iat' => DateTime.now().getTime()/1000,
    'exp' => (DateTime.now().getTime()/1000) + 300  // 5 min
}, jwtSecretFromCustomMetadata());
req.setHeader('Authorization', 'Bearer ' + jwt);
```

Where `mintHs256Jwt` does the base64url(header) + base64url(payload) + HMAC-SHA256 signature. We can add this helper in a follow-up commit.

### 4c. Configure the server's own SF connection (for callbacks + MCP)

The server logs in to Salesforce **as itself** (a System Integration user) to load agent definitions and write audit logs back. Use **JWT Bearer Token Flow**:

1. `openssl req -x509 -nodes -newkey rsa:2048 -keyout keys/server.key -out keys/server.crt -days 365 -subj "/CN=SynapseAIServer"`
2. Setup → **App Manager** → New Connected App:
   - Enable OAuth Settings
   - Check **Use digital signatures**, upload `server.crt`
   - OAuth Scopes: `api`, `refresh_token`, `offline_access`
   - **Save**
3. Copy the **Consumer Key** into `SF_CLIENT_ID`
4. In Setup → **Manage Apps** → the new app → **Manage** → **Permitted Users: Admin approved**, then pre-authorize a System Integration user via a permission set
5. Set `SF_USERNAME` to that user's username
6. `SF_PRIVATE_KEY_PATH=./keys/server.key`

## 5. End-to-end test

1. Deploy SF metadata: `sf project deploy start --target-org <your-org>`
2. Assign the permission set: `sf org assign permset --name AgentBuilderUser`
3. Open the **Synapse AI** app from the App Launcher
4. Click **+ New Agent**, drag a **Record trigger** → **Claude AI** → **End**, save with name "Lead Qualifier" and ApiName `lead_qualifier`, set Status to Active
5. From the Test Runner: enter a Lead ID, click **Run agent**
6. Watch the server log — you should see `claude_call_complete` with `cache_creation` on the first call, then `cache_read > 0` on subsequent calls (proving the knowledge-base prompt cache is working)

## Project layout

```
src/
├── index.ts                 Express entry, mounts routers, error handler
├── config.ts                Typed env config
├── logger.ts                pino logger
├── types.ts                 Shared types (AgentDefinition, NodeResult, ...)
├── auth/jwt.ts              JWT verify middleware
├── routes/
│   ├── agent.routes.ts      POST /agent/execute, GET /agent/status/:id
│   └── health.routes.ts     GET /health
├── orchestrator/
│   ├── engine.ts            runAgent() — BFS walks the graph
│   ├── context.ts           ExecutionContext + {!var} interpolation
│   └── graph.ts             Builds adjacency map from CanvasJson__c
├── nodes/
│   ├── registry.ts          subType → executor lookup
│   ├── trigger.ts           record / schedule / webhook / platform_event
│   ├── ai.ts                claude (real), gpt4 / einstein / sentiment (stubs)
│   ├── action.ts            get/update/create/query record, create_task, post_chatter
│   ├── channel.ts           outlook / gmail / sendgrid / twilio / slack / teams (stubs)
│   ├── logic.ts             if_else (real), loop / wait / approval
│   └── end.ts
├── mcp/
│   ├── registry.ts          MCP server name lookup
│   └── servers/
│       ├── ai-models.ts     Claude integration (Opus 4.7 + adaptive thinking + prompt caching)
│       └── salesforce-crm.ts  jsforce-backed CRUD + SOQL
└── salesforce/
    ├── client.ts            jsforce JWT-bearer login, loadAgentDefinition()
    └── callback.ts          Publishes AgentExecutionResult__e events
```

## Adding a new node type

1. Create or pick an MCP server under `src/mcp/servers/`
2. Write the executor in `src/nodes/<category>.ts` and call `register('your_subtype', execFn)`
3. Import the file in `src/orchestrator/engine.ts` (side-effect import — runs the `register()` call)
4. Add the field schema to `agentPropertiesPanel.js` so the canvas UI shows config inputs
5. Add an entry to `NODE_PALETTE` in `agentCanvas.js` so the node appears in the palette

## Adding a new MCP server

1. Create `src/mcp/servers/<name>.ts` and export typed functions (`callX`, `queryY`, ...)
2. Add `<name>` to the `MCP_SERVERS` const in `src/mcp/registry.ts`
3. Reference the server from node executors via direct function imports

When the official MCP wire protocol stabilizes, swap the direct imports for an MCP client that dispatches by `node.mcpServer` + `node.mcpTool` — the registry is already shaped for this.

## Deploying to production

- **Heroku/Fly.io**: works out of the box. Set the same env vars in the dashboard. Use `npm run build && npm start` as the start command.
- **AWS Lambda + API Gateway**: wrap the express app with `serverless-http` — note that JWT-bearer SF logins should be cached in a warm container or pulled from Secrets Manager.
- **Containerized**: a 2-stage Dockerfile (build with full deps, run with `node:20-alpine`) is the standard path.

## Cost considerations

- The first call to a given agent **writes** the knowledge-base prompt cache (~1.25× input cost)
- Every call after that **reads** it (~0.1× input cost) — this is why we put the KB at the top of `system` with `cache_control`
- Adaptive thinking + `effort: "high"` on Opus 4.7 gives the best quality; drop to `medium` if you need lower per-call cost
- For latency-sensitive use cases, swap `claude-opus-4-7` → `claude-haiku-4-5` per node — the UI exposes this in the properties panel
