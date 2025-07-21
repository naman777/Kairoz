// src/agents/agent-coordinator.ts
import { Logger } from "winston";
import { Queue, Worker, Job } from "bullmq";
import { AgentFactory, AgentType } from "./agent-factory";
import { z } from "zod";
import { PrismaClient } from "../generated/prisma";

const TaskInputSchema = z.object({
  agentType: z.enum(["OrchestratorAgent", "DeploymentAgent", "MonitoringAgent", "DiagnosisAgent"]),
  taskId: z.string(),
  input: z.any(),
  priority: z.number().optional().default(50),
  delay: z.number().optional().default(0),
  attempts: z.number().optional().default(1), // Reduced from 3 to 1 to prevent multiple runs
});

interface TaskResult {
  taskId: string;
  agentType: AgentType;
  status: "success" | "failed" | "retry";
  result?: any;
  error?: string;
  duration: number;
}

export class AgentCoordinator {
  private prisma: PrismaClient;
  private logger: Logger;
  private agentFactory: AgentFactory;
  private taskQueue: Queue;
  private worker: Worker;
  private isRunning: boolean = false;

  // Task execution statistics
  private stats = {
    totalTasks: 0,
    successfulTasks: 0,
    failedTasks: 0,
    averageExecutionTime: 0,
    tasksInProgress: 0,
  };

  constructor(prisma: PrismaClient, logger: Logger, redisConnection: any) {
    this.prisma = prisma;
    this.logger = logger;
    this.agentFactory = new AgentFactory(prisma, logger);

    // Initialize task queue
    this.taskQueue = new Queue("agent-tasks", {
      connection: redisConnection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 2000,
        },
      },
    });

    // Initialize worker
    this.worker = new Worker("agent-tasks", this.processTask.bind(this), {
      connection: redisConnection,
      concurrency: 5, // Process up to 5 tasks concurrently
    });

    this.setupWorkerEventListeners();
  }

  /**
   * Setup event listeners for the worker
   */
  private setupWorkerEventListeners(): void {
    this.worker.on("completed", (job: Job, result: TaskResult) => {
      this.stats.successfulTasks++;
      this.stats.tasksInProgress--;
      this.updateAverageExecutionTime(result.duration);

      this.logger.info(`Task ${job.id} completed successfully`, {
        taskId: result.taskId,
        agentType: result.agentType,
        duration: result.duration,
      });

      // If orchestrator completed, automatically process any new pending tasks
      if (result.agentType === 'OrchestratorAgent') {
        setTimeout(async () => {
          try {
            await this.processPendingTasksFromDB();
            this.logger.info('Processed pending tasks after orchestrator completion');
          } catch (error) {
            this.logger.error('Failed to process pending tasks after orchestrator completion:', error);
          }
        }, 500); // Small delay to ensure database writes are complete
      }
    });

    this.worker.on("failed", (job: Job | undefined, err: Error) => {
      this.stats.failedTasks++;
      this.stats.tasksInProgress--;

      if (job) {
        this.logger.error(`Task ${job.id} failed`, {
          error: err.message,
          stack: err.stack,
          jobData: job.data,
        });
      } else {
        this.logger.error("A task failed, but job is undefined", {
          error: err.message,
          stack: err.stack,
        });
      }
    });

    this.worker.on("progress", (job: Job, progress: number | object) => {
      if (typeof progress === "number") {
        this.logger.debug(`Task ${job.id} progress: ${progress}%`);
      } else {
        this.logger.debug(`Task ${job.id} progress:`, progress);
      }
    });

    this.worker.on("error", (err: Error) => {
      this.logger.error("Worker error:", err);
    });
  }

  /**
   * Start the coordinator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Agent coordinator is already running");
      return;
    }

    try {
      this.isRunning = true;
      this.logger.info("Agent coordinator started successfully");

      // Process any pending tasks from previous runs
      await this.processPendingTasksFromDB();
    } catch (error) {
      this.logger.error("Failed to start agent coordinator:", error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the coordinator
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.isRunning = false;
      await this.worker.close();
      await this.taskQueue.close();
      this.logger.info("Agent coordinator stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping agent coordinator:", error);
      throw error;
    }
  }

  /**
   * Queue a task for execution
   */
  async queueTask(
    agentType: AgentType,
    taskId: string,
    input: any,
    options?: {
      priority?: number;
      delay?: number;
      attempts?: number;
    }
  ): Promise<string> {
    try {
      // Validate input
      const taskData = TaskInputSchema.parse({
        agentType,
        taskId,
        input,
        ...options,
      });

      // Add job to queue
      const job = await this.taskQueue.add(`${agentType}-${taskId}`, taskData, {
        priority: taskData.priority,
        delay: taskData.delay,
        attempts: taskData.attempts,
      });

      this.stats.totalTasks++;
      this.logger.info(`Queued task ${taskId} for ${agentType}`, {
        jobId: job.id,
        taskId,
        agentType,
      });

      return job.id!;
    } catch (error) {
      this.logger.error(`Failed to queue task ${taskId}:`, error);
      throw error;
    }
  }

  /**
   * Process any pending tasks from the database
   */
  async processPendingTasks(): Promise<void> {
    await this.processPendingTasksFromDB();
  }

  /**
   * Process a single task
   */
  private async processTask(job: Job): Promise<TaskResult> {
    const startTime = Date.now();
    const { agentType, taskId, input } = job.data;

    this.stats.tasksInProgress++;

    try {
      this.logger.info(`Processing task ${taskId} with ${agentType} agent`);

      // Update task status to in progress
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: {
          status: "IN_PROGRESS",
          startedAt: new Date(),
        },
      });

      // Execute the task using the appropriate agent
      const result = await this.agentFactory.executeTask(
        agentType,
        taskId,
        input
      );

      const duration = Date.now() - startTime;

      return {
        taskId,
        agentType,
        status: "success",
        result,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Update task status to failed
      await this.prisma.agentTask.update({
        where: { id: taskId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
        },
      });

      this.logger.error(`Task ${taskId} failed:`, error);

      return {
        taskId,
        agentType,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
        duration,
      };
    }
  }

  /**
   * Map database agent name to AgentType
   */
  private mapAgentNameToType(agentName: string): AgentType {
    switch (agentName) {
      case 'Orchestrator':
        return 'OrchestratorAgent';
      case 'Deployment':
        return 'DeploymentAgent';
      case 'Monitoring':
        return 'MonitoringAgent';
      case 'Diagnosis':
        return 'DiagnosisAgent';
      default:
        throw new Error(`Unknown agent name: ${agentName}`);
    }
  }

  /**
   * Process pending tasks from database
   */
  private async processPendingTasksFromDB(): Promise<void> {
    try {
      const pendingTasks = await this.prisma.agentTask.findMany({
        where: {
          status: "PENDING",
        },
        orderBy: {
          createdAt: "asc",
        },
        take: 50, // Limit to prevent overwhelming the queue
      });

      for (const task of pendingTasks) {
        try {
          const agentType = this.mapAgentNameToType(task.agentName);
          
          // Check if task is still pending before queuing
          const currentTask = await this.prisma.agentTask.findUnique({
            where: { id: task.id }
          });
          
          if (currentTask?.status === 'PENDING') {
            await this.queueTask(
              agentType,
              task.id,
              task.input || {},
              { priority: 75 } // Higher priority for recovery tasks
            );
            this.logger.info(`Queued pending task ${task.id} for ${task.agentName}`);
          } else {
            this.logger.debug(`Skipping task ${task.id} - status is ${currentTask?.status}`);
          }
        } catch (error) {
          this.logger.error(`Failed to queue task ${task.id}:`, error);
        }
      }

      if (pendingTasks.length > 0) {
        this.logger.info(
          `Queued ${pendingTasks.length} pending tasks for processing`
        );
      }
    } catch (error) {
      this.logger.error("Failed to process pending tasks:", error);
    }
  }

  /**
   * Update average execution time
   */
  private updateAverageExecutionTime(duration: number): void {
    const totalCompleted = this.stats.successfulTasks;
    this.stats.averageExecutionTime =
      (this.stats.averageExecutionTime * (totalCompleted - 1) + duration) /
      totalCompleted;
  }

  /**
   * Get task status
   */
  async getTaskStatus(taskId: string): Promise<any> {
    const task = await this.prisma.agentTask.findUnique({
      where: { id: taskId },
      include: {
        logs: {
          orderBy: { timestamp: "desc" },
          take: 10,
        },
      },
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Check if task is in queue
    const jobs = await this.taskQueue.getJobs([
      "waiting",
      "active",
      "completed",
      "failed",
    ]);
    const queueJob = jobs.find((job) => job.data.taskId === taskId);

    return {
      ...task,
      queueStatus: queueJob?.opts?.jobId
        ? {
            id: queueJob.id,
            state: await queueJob.getState(),
            progress: queueJob.progress,
            processedOn: queueJob.processedOn,
            finishedOn: queueJob.finishedOn,
          }
        : null,
    };
  }

  /**
   * Get coordinator statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<any> {
    const waiting = await this.taskQueue.getWaiting();
    const active = await this.taskQueue.getActive();
    const completed = await this.taskQueue.getCompleted();
    const failed = await this.taskQueue.getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      total: waiting.length + active.length + completed.length + failed.length,
    };
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    try {
      const jobs = await this.taskQueue.getJobs(["waiting", "active"]);
      const job = jobs.find((j) => j.data.taskId === taskId);

      if (job) {
        await job.remove();

        // Update database
        await this.prisma.agentTask.update({
          where: { id: taskId },
          data: {
            status: "FAILED",
            completedAt: new Date(),
          },
        });

        this.logger.info(`Cancelled task ${taskId}`);
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(`Failed to cancel task ${taskId}:`, error);
      return false;
    }
  }

  /**
   * Retry a failed task
   */
  async retryTask(taskId: string): Promise<string> {
    const task = await this.prisma.agentTask.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status !== "FAILED") {
      throw new Error(`Task ${taskId} is not in failed state`);
    }

    // Reset task status
    await this.prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
      },
    });

    // Re-queue the task
    return await this.queueTask(
      task.agentName as AgentType,
      taskId,
      task.input || {},
      { priority: 60, attempts: task.attempts + 1 }
    );
  }

  /**
   * Get deployment workflow status
   */
  async getDeploymentWorkflowStatus(deploymentId: string): Promise<any> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        tasks: {
          orderBy: { createdAt: "asc" },
          include: {
            logs: {
              orderBy: { timestamp: "desc" },
              take: 5,
            },
          },
        },
      },
    });

    if (!deployment) {
      throw new Error(`Deployment ${deploymentId} not found`);
    }

    // Calculate overall progress
    const totalTasks = deployment.tasks.length;
    const completedTasks = deployment.tasks.filter(
      (t) => t.status === "SUCCESS" || t.status === "FAILED"
    ).length;

    const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    // Determine overall status
    let overallStatus = deployment.status;
    if (deployment.tasks.some((t) => t.status === "REQUIRES_MANUAL_ACTION")) {
      overallStatus = "REQUIRES_MANUAL_ACTION";
    } else if (deployment.tasks.some((t) => t.status === "FAILED")) {
      overallStatus = "FAILED";
    } else if (deployment.tasks.some((t) => t.status === "IN_PROGRESS")) {
      overallStatus = "IN_PROGRESS";
    } else if (deployment.tasks.every((t) => t.status === "SUCCESS")) {
      overallStatus = "SUCCESS";
    }

    return {
      deployment,
      progress,
      overallStatus,
      tasksSummary: {
        total: totalTasks,
        pending: deployment.tasks.filter((t) => t.status === "PENDING").length,
        inProgress: deployment.tasks.filter((t) => t.status === "IN_PROGRESS")
          .length,
        success: deployment.tasks.filter((t) => t.status === "SUCCESS").length,
        failed: deployment.tasks.filter((t) => t.status === "FAILED").length,
        requiresAction: deployment.tasks.filter(
          (t) => t.status === "REQUIRES_MANUAL_ACTION"
        ).length,
      },
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<any> {
    const agentHealth = await this.agentFactory.healthCheck();
    const queueStats = await this.getQueueStats();

    return {
      coordinator: {
        running: this.isRunning,
        stats: this.getStats(),
      },
      agents: agentHealth,
      queue: queueStats,
      timestamp: new Date().toISOString(),
    };
  }
}
