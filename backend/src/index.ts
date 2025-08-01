import express from "express";
import cors from "cors";
import { env } from "./config/env";
import { db } from "./services/database";
import { queue } from "./services/queue";
import { errorHandler } from "./middleware/error-handler";
import deploymentRoutes from "./routes/deployment";
import logger from "./config/logger";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/deployments", deploymentRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
  });
});

// Error handling
app.use(errorHandler);

// Start server
async function startServer() {
  try {
    // Initialize database
    await db.connect();

    // Start the server
    app.listen(env.PORT, () => {
      logger.info(`🚀 Kairoz backend running on port ${env.PORT}`);
      logger.info(`📊 Environment: ${env.NODE_ENV}`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await queue.close();
  await db.disconnect();
  process.exit(0);
});

startServer();
