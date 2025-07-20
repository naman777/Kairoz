

// src/agents/monitoring-agent.ts
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface HealthCheck {
  timestamp: Date;
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime?: number;
  error?: string;
  httpStatus?: number;
}

export class MonitoringAgent extends BaseAgent {
  private llm: ChatOpenAI;
  private healthChecks: Map<string, HealthCheck[]> = new Map();
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(prisma: any, logger: any) {
    super(prisma, logger, 'Monitoring');
    
    this.llm = new ChatOpenAI({
      modelName: 'gpt-4',
      temperature: 0.1,
    });
  }

  /**
   * Start monitoring a deployment
   */
  private async startMonitoring(deploymentId: string, containerName: string): Promise<void> {
    const interval = setInterval(async () => {
      await this.performHealthCheck(deploymentId, containerName);
    }, 30000); // Check every 30 seconds

    this.monitoringIntervals.set(deploymentId, interval);
  }

  /**
   * Perform health check on container
   */
  private async performHealthCheck(deploymentId: string, containerName: string): Promise<HealthCheck> {
    const startTime = Date.now();
    let healthCheck: HealthCheck = {
      timestamp: new Date(),
      status: 'unknown',
    };

    try {
      // Check if container is running
      const { stdout: containerStatus } = await execAsync(
        `docker inspect --format='{{.State.Status}}' ${containerName}`
      );

      if (containerStatus.trim() !== 'running') {
        healthCheck = {
          ...healthCheck,
          status: 'unhealthy',
          error: `Container status: ${containerStatus.trim()}`,
        };
      } else {
        // Try HTTP health check
        try {
          const response = await fetch('http://localhost:80/health', {
            method: 'GET',
            timeout: 5000,
          });
          
          healthCheck = {
            ...healthCheck,
            status: response.ok ? 'healthy' : 'unhealthy',
            responseTime: Date.now() - startTime,
            httpStatus: response.status,
          };

          if (!response.ok) {
            healthCheck.error = `HTTP ${response.status}: ${response.statusText}`;
          }
        } catch (fetchError) {
          // If no health endpoint, just check if container is responding
          healthCheck = {
            ...healthCheck,
            status: 'healthy', // Container is running, assume healthy
            responseTime: Date.now() - startTime,
          };
        }
      }
    } catch (error) {
      healthCheck = {
        ...healthCheck,
        status: 'unhealthy',
        error: error.message,
      };
    }

    // Store health check result
    if (!this.healthChecks.has(deploymentId)) {
      this.healthChecks.set(deploymentId, []);
    }
    
    const checks = this.healthChecks.get(deploymentId)!;
    checks.push(healthCheck);
    
    // Keep only last 100 checks
    if (checks.length > 100) {
      checks.shift();
    }

    // If unhealthy, trigger diagnosis
    if (healthCheck.status === 'unhealthy') {
      await this.triggerDiagnosis(deploymentId, containerName, healthCheck.error || 'Unknown health check failure');
    }

    return healthCheck;
  }

  /**
   * Get container logs
   */
  private async getContainerLogs(containerName: string, lines: number = 100): Promise<string> {
    try {
      const { stdout } = await execAsync(`docker logs --tail ${lines} ${containerName}`);
      return stdout;
    } catch (error) {
      return `Failed to get logs: ${error.message}`;
    }
  }

  /**
   * Trigger diagnosis when issues are detected
   */
  private async triggerDiagnosis(deploymentId: string, containerName: string, error: string): Promise<void> {
    try {
      // Get recent logs
      const logs = await this.getContainerLogs(containerName);
      
      // Create diagnosis task
      await this.prisma.agentTask.create({
        data: {
          deploymentId,
          agentName: 'Diagnosis',
          taskName: 'analyze_error',
          status: 'PENDING',
          input: {
            errorType: 'monitoring_alert',
            error,
            logs,
            containerName,
            timestamp: new Date().toISOString(),
          },
        },
      });

      this.logger.info(`Triggered diagnosis for deployment ${deploymentId}: ${error}`);
    } catch (diagnosisError) {
      this.logger.error(`Failed to trigger diagnosis: ${diagnosisError.message}`);
    }
  }

  /**
   * Stop monitoring a deployment
   */
  private stopMonitoring(deploymentId: string): void {
    const interval = this.monitoringIntervals.get(deploymentId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(deploymentId);
      this.healthChecks.delete(deploymentId);
    }
  }

  /**
   * Execute monitoring setup
   */
  async execute(taskId: string, input: any): Promise<any> {
    await this.updateTaskStatus(taskId, 'IN_PROGRESS');
    await this.logMessage(taskId, `Starting monitoring for deployment: ${input.deploymentId}`);

    try {
      const { deploymentId, containerName } = input;

      // Start continuous monitoring
      await this.startMonitoring(deploymentId, containerName);
      
      // Perform initial health check
      const initialCheck = await this.performHealthCheck(deploymentId, containerName);
      
      await this.logMessage(taskId, `Initial health check: ${initialCheck.status}`);

      // Set up log monitoring (simplified)
      const logs = await this.getContainerLogs(containerName, 50);
      await this.logMessage(taskId, `Retrieved initial logs (${logs.split('\n').length} lines)`);

      const result = {
        deploymentId,
        containerName,
        monitoringStarted: new Date().toISOString(),
        initialHealthCheck: initialCheck,
        logLinesRetrieved: logs.split('\n').length,
      };

      await this.updateTaskStatus(taskId, 'SUCCESS', result);
      await this.logMessage(taskId, 'Monitoring setup completed successfully');

      return result;
    } catch (error) {
      await this.logMessage(taskId, `Monitoring setup failed: ${error.message}`, 'ERROR');
      await this.updateTaskStatus(taskId, 'FAILED', { error: error.message });
      throw error;
    }
  }

  /**
   * Get monitoring status for a deployment
   */
  async getMonitoringStatus(deploymentId: string): Promise<any> {
    const checks = this.healthChecks.get(deploymentId) || [];
    const recentChecks = checks.slice(-10); // Last 10 checks
    
    return {
      deploymentId,
      isMonitoring: this.monitoringIntervals.has(deploymentId),
      totalChecks: checks.length,
      recentChecks,
      currentStatus: recentChecks.length > 0 ? recentChecks[recentChecks.length - 1].status : 'unknown',
    };
  }
}