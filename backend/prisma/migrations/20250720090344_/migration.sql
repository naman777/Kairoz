/*
  Warnings:

  - The values [WARN] on the enum `LogLevel` will be removed. If these variants are still used in the database, this will fail.
  - The values [CANCELLED] on the enum `Status` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `deploymentId` on the `logs` table. All the data in the column will be lost.
  - Added the required column `agentTaskId` to the `logs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "LogLevel_new" AS ENUM ('INFO', 'ERROR', 'DEBUG', 'SYSTEM');
ALTER TABLE "logs" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "logs" ALTER COLUMN "type" TYPE "LogLevel_new" USING ("type"::text::"LogLevel_new");
ALTER TYPE "LogLevel" RENAME TO "LogLevel_old";
ALTER TYPE "LogLevel_new" RENAME TO "LogLevel";
DROP TYPE "LogLevel_old";
ALTER TABLE "logs" ALTER COLUMN "type" SET DEFAULT 'INFO';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "Status_new" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'REQUIRES_MANUAL_ACTION');
ALTER TABLE "deployments" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "deployments" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TABLE "agent_tasks" ALTER COLUMN "status" TYPE "Status_new" USING ("status"::text::"Status_new");
ALTER TYPE "Status" RENAME TO "Status_old";
ALTER TYPE "Status_new" RENAME TO "Status";
DROP TYPE "Status_old";
ALTER TABLE "deployments" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "logs" DROP CONSTRAINT "logs_deploymentId_fkey";

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "domain" TEXT,
ALTER COLUMN "repoUrl" DROP NOT NULL;

-- AlterTable
ALTER TABLE "logs" DROP COLUMN "deploymentId",
ADD COLUMN     "agentTaskId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnoses" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "errorLog" TEXT NOT NULL,
    "rootCause" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "retrievedContextIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diagnoses_deploymentId_key" ON "diagnoses"("deploymentId");

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
