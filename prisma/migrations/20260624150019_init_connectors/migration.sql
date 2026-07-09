-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "authType" TEXT NOT NULL DEFAULT 'OAuth2',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "scopes" TEXT,
    "instanceUrl" TEXT,
    "accountEmail" TEXT,
    "externalAccountId" TEXT,
    "apiKey" TEXT,
    "configuredBy" TEXT,
    "lastConnectedAt" DATETIME,
    "lastErrorMessage" TEXT,
    "configJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PendingOAuth" (
    "state" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "connectorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Connector_orgId_idx" ON "Connector"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_orgId_providerKey_key" ON "Connector"("orgId", "providerKey");

-- CreateIndex
CREATE INDEX "PendingOAuth_orgId_idx" ON "PendingOAuth"("orgId");
