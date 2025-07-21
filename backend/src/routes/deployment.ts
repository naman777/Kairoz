import { Router } from "express";
import { queue } from "../services/queue";
import { db } from "../services/database";
import { z } from "zod";
import { AgentCoordinator } from "../agents/agent-coordinator";
import { loggers } from "winston";

const router = Router();

const deployCommandSchema = z.object({
  action: z.enum(["deploy", "monitor", "diagnose", "stop"]),
  repoUrl: z.string().url().optional(),
  domain: z.string().optional(),
  deploymentId: z.string().optional(),
});

type DeployCommand = z.infer<typeof deployCommandSchema>;

// POST /api/deploy - Deploy an application
router.post("/deploy", async (req, res) => {
  try {
    const command = deployCommandSchema.parse(req.body);

    // Create deployment record first
    const deployment = await db.prisma.deployment.create({
      data: {
        repoUrl: command.repoUrl,
        domain: command.domain,
        status: 'PENDING',
      },
    });

    // Create a deployment job with the deployment ID
    const job = await queue.addDeploymentJob({
      ...command,
      deploymentId: deployment.id,
    });

    res.json({
      success: true,
      jobId: job.id,
      deploymentId: deployment.id,
      message: "Deployment job created successfully",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid input data",
        details: error.errors,
      });
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});

// GET /api/deploy/status/:jobId - Get deployment status
router.get("/status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = await queue.getJobStatus(jobId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    res.json({
      success: true,
      job: status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch job status",
    });
  }
});

// GET /api/deploy/deployments - Get all deployments
router.get("/deployments", async (req, res) => {
  try {
    const deployments = await db.prisma.deployment.findMany({
      orderBy: { createdAt: "desc" },
      take: 50, // Limit to 50 most recent
    });

    res.json({
      success: true,
      deployments,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch deployments",
    });
  }
});

// DELETE /api/deploy/:deploymentId - Stop a deployment
router.delete("/:deploymentId", async (req, res) => {
  try {
    const { deploymentId } = req.params;

    const deployment = await db.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: "Deployment not found",
      });
    }

    // Create a stop job
    const job = await queue.addDeploymentJob({
      action: "stop",
      deploymentId,
    });

    res.json({
      success: true,
      jobId: job.id,
      message: "Stop deployment job created successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to stop deployment",
    });
  }
});

// POST /api/deploy/process-pending - Manually trigger processing of pending tasks
router.post("/process-pending", async (req, res) => {
  try {
    // Create agent coordinator instance with proper parameters
    const logger = loggers.get('default') || console as any;
    const coordinator = new AgentCoordinator(db.prisma, logger, null);
    await coordinator.processPendingTasks();
    
    res.json({
      success: true,
      message: "Processed pending tasks successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to process pending tasks",
    });
  }
});

// GET /api/deploy/tasks - Get all agent tasks with their status
router.get("/tasks", async (req, res) => {
  try {
    const tasks = await db.prisma.agentTask.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        deployment: true,
        logs: {
          orderBy: { timestamp: "desc" },
          take: 5,
        },
      },
    });

    res.json({
      success: true,
      tasks,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch tasks",
    });
  }
});

export default router;
