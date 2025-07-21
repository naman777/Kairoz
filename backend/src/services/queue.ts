import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
import { AgentCoordinator } from "../agents/agent-coordinator";
import { DeploymentCommand } from "../types";
import { redisClient } from "../config/redis";
import { PrismaClient } from "../generated/prisma";
import { prisma } from "../config/prisma";
import { loggers } from "winston";
import logger from "../config/logger";

class QueueService {
  private static instance: QueueService;
  private redis: Redis;
  private deploymentQueue: Queue;
  private worker!: Worker;
  private prisma: PrismaClient;

  private constructor() {
    this.prisma = prisma;

    this.redis = redisClient;

    this.deploymentQueue = new Queue("deployment", {
      connection: this.redis,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 1, // Reduced from 3 to 1 to prevent multiple runs
        backoff: {
          type: "exponential",
          delay: 2000,
        },
      },
    });

    this.setupWorker();
  }

  public static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  private setupWorker() {
    this.worker = new Worker(
      "deployment",
      async (job: Job<DeploymentCommand>) => {
        logger.info(`Processing job ${job.id}: ${job.data.action}`);
        logger.debug(`Job data:`, job.data);

        try {
          // Initialize the coordinator
          const coordinator = new AgentCoordinator(
            this.prisma,
            loggers.get("default"),
            this.redis
          );
          await coordinator.start();

          // For deploy action, queue an orchestrator task to handle the deployment
          if (job.data.action === "deploy") {
            // Validate required fields
            if (!job.data.deploymentId) {
              throw new Error("Deployment ID is required for deploy action");
            }
            if (!job.data.repoUrl) {
              throw new Error("Repository URL is required for deploy action");
            }

            // Create user command string from deployment data
            const userCommand = `deploy ${job.data.repoUrl}${
              job.data.domain ? ` to ${job.data.domain}` : ""
            }`;

            // Create an agent task record in the database first
            const agentTask = await this.prisma.agentTask.create({
              data: {
                deploymentId: job.data.deploymentId,
                agentName: "Orchestrator",
                taskName: "Deploy Orchestration",
                status: "PENDING",
                input: {
                  userCommand,
                  deploymentId: job.data.deploymentId,
                  repoUrl: job.data.repoUrl,
                  domain: job.data.domain,
                },
              },
            });

            // Queue orchestrator task using the database record ID
            const jobId = await coordinator.queueTask(
              "OrchestratorAgent",
              agentTask.id, // Use the database record ID
              {
                userCommand,
                deploymentId: job.data.deploymentId,
                repoUrl: job.data.repoUrl,
                domain: job.data.domain,
              },
              {
                priority: 10,
                attempts: 1, // Reduced attempts to prevent multiple runs
              }
            );

            logger.info(
              `Created agent task ${agentTask.id} and queued orchestrator job ${jobId}`
            );

            // Return the job ID for tracking
            return {
              success: true,
              taskId: agentTask.id,
              jobId,
              action: job.data.action,
              deploymentId: job.data.deploymentId,
            };
          } else {
            throw new Error(`Unsupported action: ${job.data.action}`);
          }
        } catch (error) {
          logger.error(`Failed to process job ${job.id}:`, error);
          throw error;
        }
      },
      {
        connection: this.redis,
        concurrency: 3,
      }
    );

    this.worker.on("completed", async (job, result) => {
      logger.info(`Job ${job.id} completed:`, result);

      // If this was a deployment job that started an orchestrator, process pending tasks
      if (job.data.action === "deploy" && result?.success) {
        try {
          // Wait a moment for the orchestrator to finish creating tasks
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Create a new coordinator instance to process pending tasks
          const coordinator = new AgentCoordinator(
            this.prisma,
            loggers.get("default"),
            this.redis
          );
          await coordinator.processPendingTasks();
          logger.info(
            "Processed pending tasks after deployment job completion"
          );
        } catch (error) {
          logger.error(
            "Failed to process pending tasks after deployment completion:",
            error
          );
        }
      }

      if (job.data.action === "monitor") {
        // Handle monitoring job completion
        logger.info(`Monitoring job ${job.id} completed successfully`);
        // Process any new pending tasks
        const coordinator = new AgentCoordinator(
          this.prisma,
          loggers.get("default"),
          this.redis
        );
        await coordinator.processPendingTasks();
      }
    });

    this.worker.on("failed", (job, err) => {
      logger.error(`Job ${job?.id} failed:`, err);
    });
  }

  async addDeploymentJob(command: DeploymentCommand) {
    return this.deploymentQueue.add(
      `${command.action}-${Date.now()}`,
      command,
      {
        priority: command.action === "deploy" ? 10 : 5,
      }
    );
  }

  async getJobStatus(jobId: string) {
    const job = await this.deploymentQueue.getJob(jobId);
    return job
      ? {
          id: job.id,
          status: await job.getState(),
          progress: job.progress,
          data: job.data,
          result: job.returnvalue,
          error: job.failedReason,
        }
      : null;
  }

  async close() {
    await this.worker.close();
    await this.deploymentQueue.close();
    await this.redis.disconnect();
  }
}

export const queue = QueueService.getInstance();
