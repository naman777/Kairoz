import { Queue, Worker, Job } from "bullmq";
import Redis from "ioredis";
import { AgentCoordinator } from "../agents/agent-coordinator";
import { DeploymentCommand } from "../types";
import { redisClient } from "@/config/redis";
import { PrismaClient } from "@/generated/prisma";
import { prisma } from "@/config/prisma";

class QueueService {
  private static instance: QueueService;
  private redis: Redis;
  private deploymentQueue: Queue;
  private worker!: Worker;
  private prisma : PrismaClient

  private constructor() {
    this.prisma = prisma;

    this.redis = redisClient;

    this.deploymentQueue = new Queue("deployment", {
      connection: this.redis,
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
        console.log(`Processing job ${job.id}: ${job.data.action}`);

        const coordinator = new AgentCoordinator(this.prisma, this.redis, job.data);
        const result = await coordinator.execute(job.data);

        return result;
      },
      {
        connection: this.redis,
        concurrency: 3,
      }
    );

    this.worker.on("completed", (job, result) => {
      console.log(`Job ${job.id} completed:`, result);
    });

    this.worker.on("failed", (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
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
