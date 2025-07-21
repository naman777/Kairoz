// src/agents/orchestrator-agent.ts
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from 'langchain/prompts';
import { HumanMessage } from 'langchain/schema';
import { z } from 'zod';
import { StructuredOutputParser } from 'langchain/output_parsers';

// Schema for parsing user commands
const CommandParseSchema = z.object({
  action: z.enum(['deploy', 'monitor', 'diagnose', 'status']),
  repoUrl: z.string().optional(),
  domain: z.string().optional(),
  deploymentId: z.string().optional(),
  additionalContext: z.string().optional(),
});

const DeploymentPlanSchema = z.object({
  steps: z.array(z.object({
    stepNumber: z.number(),
    agentName: z.string(),
    taskName: z.string(),
    description: z.string(),
    dependencies: z.array(z.number()).optional(),
  })),
  estimatedDuration: z.string(),
  requirements: z.array(z.string()).optional(),
});

export class OrchestratorAgent extends BaseAgent {
  private llm: ChatOpenAI;
  private commandParser: StructuredOutputParser<typeof CommandParseSchema>;
  private planParser: StructuredOutputParser<typeof DeploymentPlanSchema>;

  constructor(prisma: any, logger: any) {
    super(prisma, logger, 'Orchestrator');
    
    this.llm = new ChatOpenAI({
      modelName: 'gpt-4.1-nano',
      temperature: 0.1,
    });

    this.commandParser = StructuredOutputParser.fromZodSchema(CommandParseSchema);
    this.planParser = StructuredOutputParser.fromZodSchema(DeploymentPlanSchema);
  }

  /**
   * Parse natural language user input into structured command
   */
  async parseUserCommand(userInput: string): Promise<z.infer<typeof CommandParseSchema>> {
    const parsePrompt = PromptTemplate.fromTemplate(`
      You are an AI assistant that parses DevOps commands. Parse the following user input into a structured format.

      User Input: "{userInput}"

      Extract:
      - action: What the user wants to do (deploy, monitor, diagnose, status)
      - repoUrl: Git repository URL if mentioned
      - domain: Target domain if mentioned
      - deploymentId: Existing deployment ID if referenced
      - additionalContext: Any other relevant information

      {format_instructions}
    `);

    const prompt = await parsePrompt.format({
      userInput,
      format_instructions: this.commandParser.getFormatInstructions(),
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return await this.commandParser.parse(responseContent) as z.infer<typeof CommandParseSchema>;
  }

  /**
   * Create a deployment plan based on parsed command
   */
  async createDeploymentPlan(command: z.infer<typeof CommandParseSchema>): Promise<z.infer<typeof DeploymentPlanSchema>> {
    const planPrompt = PromptTemplate.fromTemplate(`
      Create a detailed deployment plan for the following command:
      
      Action: {action}
      Repository: {repoUrl}
      Domain: {domain}
      
      Available Agents:
      - Deployment: Handles git cloning, dockerfile generation, docker builds, container deployment
      - Monitoring: Sets up monitoring, log collection, health checks
      - Diagnosis: Analyzes errors, provides root cause analysis and fixes

      Create a step-by-step plan that coordinates these agents effectively.
      Each step should specify which agent to use and what task to perform.

      {format_instructions}
    `);

    const prompt = await planPrompt.format({
      action: command.action,
      repoUrl: command.repoUrl || 'Not specified',
      domain: command.domain || 'Not specified',
      format_instructions: this.planParser.getFormatInstructions(),
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return await this.planParser.parse(responseContent) as z.infer<typeof DeploymentPlanSchema>;
  }

  /**
   * Map LLM-generated agent names to standardized enum values
   */
  private mapAgentName(agentName: string): string {
    const normalizedName = agentName.toLowerCase().replace(/agent$/i, '');
    
    switch (normalizedName) {
      case 'deployment':
      case 'deploy':
        return 'Deployment';
      case 'monitoring':
      case 'monitor':
        return 'Monitoring';
      case 'diagnosis':
      case 'diagnose':
      case 'diagnostic':
        return 'Diagnosis';
      case 'orchestrator':
      case 'orchestrate':
        return 'Orchestrator';
      default:
        // Default to Deployment if unknown
        return 'Deployment';
    }
  }

  /**
   * Execute orchestration logic
   */
  async execute(taskId: string, input: { userCommand: string }): Promise<any> {
    await this.updateTaskStatus(taskId, 'IN_PROGRESS');
    await this.logMessage(taskId, `Processing user command: ${input.userCommand}`);

    try {
      // Step 1: Parse the user command
      const parsedCommand = await this.parseUserCommand(input.userCommand);
      await this.logMessage(taskId, `Parsed command: ${JSON.stringify(parsedCommand)}`);

      // Step 2: Create deployment if it's a deploy action
      let deploymentId: string;
      
      if (parsedCommand.action === 'deploy') {
        const deployment = await this.prisma.deployment.create({
          data: {
            repoUrl: parsedCommand.repoUrl,
            domain: parsedCommand.domain,
            status: 'PENDING',
          },
        });
        deploymentId = deployment.id;
        await this.logMessage(taskId, `Created deployment: ${deploymentId}`);
      } else if (parsedCommand.deploymentId) {
        deploymentId = parsedCommand.deploymentId;
      } else {
        throw new Error('No deployment ID provided for non-deploy action');
      }

      // Step 3: Create deployment plan
      const plan = await this.createDeploymentPlan(parsedCommand);
      await this.logMessage(taskId, `Created deployment plan with ${plan.steps.length} steps`);

      // Step 4: Create agent tasks for each step in the plan
      const createdTasks = [];
      for (const step of plan.steps) {
        const standardizedAgentName = this.mapAgentName(step.agentName);
        
        const agentTask = await this.prisma.agentTask.create({
          data: {
            deploymentId,
            agentName: standardizedAgentName,
            taskName: step.taskName,
            status: 'PENDING',
            input: {
              stepNumber: step.stepNumber,
              description: step.description,
              repoUrl: parsedCommand.repoUrl,
              domain: parsedCommand.domain,
              dependencies: step.dependencies || [],
            },
          },
        });
        createdTasks.push(agentTask);
        await this.logMessage(taskId, `Created task: ${agentTask.id} for ${standardizedAgentName} (originally ${step.agentName})`);
      }

      const result = {
        deploymentId,
        parsedCommand,
        plan,
        createdTasks: createdTasks.map(task => ({
          id: task.id,
          agentName: task.agentName,
          taskName: task.taskName,
        })),
      };

      await this.updateTaskStatus(taskId, 'SUCCESS', result);
      await this.logMessage(taskId, 'Orchestration completed successfully');

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown orchestration error';
      await this.logMessage(taskId, `Orchestration failed: ${errorMessage}`, 'ERROR');
      await this.updateTaskStatus(taskId, 'FAILED', { error: errorMessage });
      throw error;
    }
  }
}