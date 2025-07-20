import { Router } from "express";
import { queue } from "../services/queue";
import { db } from "../services/database";
import { z } from "zod";

const router = Router();

const deployCommandSchema = z.object({
  action: z.enum(["deploy", "monitor", "diagnose", "stop"]),
  repoUrl: z.string().url().optional(),
  domain: z.string().optional(),
  deploymentId: z.string().optional(),
});

// Deploy endpoint
router.post("/", async (req, res) => {
  try {
    const command = deployCommandSchema.parse(req.body);

    // Create deployment record if it's a new deployment
    let deploymentId = command.deploymentId;
    if (command.action === "deploy" && !deploymentId) {
      const deployment = await db.createDeployment(
        command.repoUrl,
        command.domain
      );
      deploymentId = deployment.id;
    }

    // Add job to queue
    const job = await queue.addDeploymentJob({
      ...command,
      deploymentId,
    });

    res.json({
      success: true,
      jobId: job.id,
      deploymentId,
      message: `${command.action} job queued successfully`,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid request",
    });
  }
});

// Get deployment status
router.get("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;

    const deployment = await db.prisma.deployment.findUnique({
      where: { id },
      include: {
        tasks: {
          orderBy: { startedAt: "desc" },
          include: { logs: true },
        },
        diagnoses: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!deployment) {
      return res.status(404).json({
        success: false,
        error: "Deployment not found",
      });
    }

    res.json({
      success: true,
      deployment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to fetch deployment status",
    });
  }
});

// Get job status
router.get("/jobs/:jobId/status", async (req, res) => {
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

export { router as deploymentRoutes };
