// src/agents/agent-factory.ts

import { Logger } from "winston";
import { BaseAgent } from "./base-agent";
import { OrchestratorAgent } from "./orchestrator-agent";
import { DeploymentAgent } from "./deployment-agent";
import { MonitoringAgent } from "./monitoring-agent";
import { DiagnosisAgent } from "./diagnosis-agent";
import { PrismaClient } from "@/generated/prisma";

export type AgentType =
  | "Orchestrator"
  | "Deployment"
  | "Monitoring"
  | "Diagnosis";

export class AgentFactory {
  private prisma: PrismaClient;
  private logger: Logger;
  private agents: Map<AgentType, BaseAgent> = new Map();

  constructor(prisma: PrismaClient, logger: Logger) {
    this.prisma = prisma;
    this.logger = logger;
    this.initializeAgents();
  }

  /**
   * Initialize all agents
   */
  private initializeAgents(): void {
    this.agents.set(
      "Orchestrator",
      new OrchestratorAgent(this.prisma, this.logger)
    );
    this.agents.set(
      "Deployment",
      new DeploymentAgent(this.prisma, this.logger)
    );
    this.agents.set(
      "Monitoring",
      new MonitoringAgent(this.prisma, this.logger)
    );
    this.agents.set("Diagnosis", new DiagnosisAgent(this.prisma, this.logger));
  }

  /**
   * Get agent by type
   */
  getAgent(agentType: AgentType): BaseAgent {
    const agent = this.agents.get(agentType);
    if (!agent) {
      throw new Error(`Agent type ${agentType} not found`);
    }
    return agent;
  }

  /**
   * Execute agent task
   */
  async executeTask(
    agentType: AgentType,
    taskId: string,
    input: any
  ): Promise<any> {
    const agent = this.getAgent(agentType);
    return await agent.execute(taskId, input);
  }

  /**
   * Get all available agent types
   */
  getAvailableAgents(): AgentType[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Health check for all agents
   */
  async healthCheck(): Promise<{ [key in AgentType]: boolean }> {
    const health: { [key in AgentType]: boolean } = {} as any;

    for (const [agentType, agent] of this.agents) {
      try {
        // Simple health check - could be expanded
        health[agentType] = agent instanceof BaseAgent;
      } catch (error) {
        health[agentType] = false;
        this.logger.error(`Health check failed for ${agentType}: ${error}`);
      }
    }

    return health;
  }
}
