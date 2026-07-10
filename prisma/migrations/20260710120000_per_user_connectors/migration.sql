-- DropIndex
DROP INDEX "Connector_orgId_providerKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Connector_orgId_providerKey_configuredBy_key" ON "Connector"("orgId", "providerKey", "configuredBy");

