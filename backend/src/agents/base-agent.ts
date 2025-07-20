// src/agents/base-agent.ts
import { PrismaClient } from '@/generated/prisma';
import { Logger } from 'winston';
import { z } from 'zod';

export abstract class BaseAgent {
  protected prisma: PrismaClient;
  protected logger: Logger;
  protected agentName: string;

  constructor(prisma: PrismaClient, logger: Logger, agentName: string) {
    this.prisma = prisma;
    this.logger = logger;
    this.agentName = agentName;
  }

  /**
   * Log a message for a specific agent task
   */
  protected async logMessage(
    agentTaskId: string,
    message: string,
    type: 'INFO' | 'ERROR' | 'DEBUG' | 'SYSTEM' = 'INFO'
  ): Promise<void> {
    await this.prisma.log.create({
      data: {
        agentTaskId,
        message,
        type,
        timestamp: new Date(),
      },
    });

    this.logger[type.toLowerCase() as keyof Logger](
      `[${this.agentName}] ${message}`
    );
  }

  /**
   * Update agent task status
   */
  protected async updateTaskStatus(
    taskId: string,
    status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | 'REQUIRES_MANUAL_ACTION',
    output?: any
  ): Promise<void> {
    const updateData: any = {
      status,
      updatedAt: new Date(),
    };

    if (status === 'IN_PROGRESS' && !output) {
      updateData.startedAt = new Date();
    }

    if (status === 'SUCCESS' || status === 'FAILED') {
      updateData.completedAt = new Date();
    }

    if (output) {
      updateData.output = output;
    }

    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: updateData,
    });
  }

  /**
   * Increment task attempts
   */
  protected async incrementAttempts(taskId: string): Promise<number> {
    const updated = await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        attempts: {
          increment: 1,
        },
      },
    });
    return updated.attempts;
  }

  /**
   * Abstract method that each agent must implement
   */
  abstract execute(taskId: string, input: any): Promise<any>;
}