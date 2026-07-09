-- CreateTable
CREATE TABLE "OrgInstall" (
    "orgId" TEXT NOT NULL PRIMARY KEY,
    "sessionKey" TEXT NOT NULL,
    "sfAccessToken" TEXT NOT NULL,
    "sfRefreshToken" TEXT,
    "sfInstanceUrl" TEXT NOT NULL,
    "sfUserId" TEXT,
    "sfUserEmail" TEXT,
    "tokenExpiresAt" DATETIME,
    "scopes" TEXT,
    "configuredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PendingSetup" (
    "state" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgInstall_sessionKey_key" ON "OrgInstall"("sessionKey");

-- CreateIndex
CREATE INDEX "PendingSetup_orgId_idx" ON "PendingSetup"("orgId");
