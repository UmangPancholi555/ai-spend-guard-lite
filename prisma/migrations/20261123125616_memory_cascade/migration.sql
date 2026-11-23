-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProjectMemoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sizeBytes" INTEGER NOT NULL,
    "estimatedTokens" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectMemoryItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProjectMemoryItem" ("category", "content", "createdAt", "enabled", "estimatedTokens", "id", "projectId", "sizeBytes", "title", "updatedAt") SELECT "category", "content", "createdAt", "enabled", "estimatedTokens", "id", "projectId", "sizeBytes", "title", "updatedAt" FROM "ProjectMemoryItem";
DROP TABLE "ProjectMemoryItem";
ALTER TABLE "new_ProjectMemoryItem" RENAME TO "ProjectMemoryItem";
CREATE INDEX "ProjectMemoryItem_projectId_enabled_idx" ON "ProjectMemoryItem"("projectId", "enabled");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
