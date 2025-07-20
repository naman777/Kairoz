import { LogLevel, PrismaClient, Status } from "../generated/prisma";
import { prisma } from "../config/prisma";

class DatabaseService {
  private static instance: DatabaseService;
  public prisma: PrismaClient;

  private constructor() {
    this.prisma = prisma;
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  async connect() {
    try {
      await this.prisma.$connect();
      console.log("✅ Database connected successfully");
    } catch (error) {
      console.error("❌ Database connection failed:", error);
      throw error;
    }
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }

  // Helper methods for common operations
  async createDeployment(repoUrl?: string, domain?: string) {
    return this.prisma.deployment.create({
      data: {
        repoUrl,
        domain,
        status: "PENDING",
      },
    });
  }

  async updateDeploymentStatus(id: string, status: Status) {
    return this.prisma.deployment.update({
      where: { id },
      data: { status, updatedAt: new Date() },
    });
  }

  async createAgentTask(
    deploymentId: string,
    agentName: string,
    taskName: string,
    input?: any
  ) {
    return this.prisma.agentTask.create({
      data: {
        deploymentId,
        agentName,
        taskName,
        input,
        status: "PENDING",
      },
    });
  }

  async updateAgentTask(
    id: string,
    data: Partial<{
      status: Status;
      output: any;
      startedAt: Date;
      completedAt: Date;
      attempts: number;
    }>
  ) {
    return this.prisma.agentTask.update({
      where: { id },
      data,
    });
  }

  async logMessage(agentTaskId: string, type: LogLevel, message: string) {
    return this.prisma.log.create({
      data: {
        agentTaskId,
        type,
        message,
      },
    });
  }

  async createDiagnosis(
    deploymentId: string,
    errorLog: string,
    rootCause: string,
    suggestion: string,
    retrievedContextIds: string[]
  ) {
    return this.prisma.diagnosis.create({
      data: {
        deploymentId,
        errorLog,
        rootCause,
        suggestion,
        retrievedContextIds,
      },
    });
  }
}

export const db = DatabaseService.getInstance();
