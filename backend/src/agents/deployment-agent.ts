// src/agents/deployment-agent.ts
import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from 'langchain/prompts';
import { HumanMessage } from 'langchain/schema';
import simpleGit from 'simple-git';
import * as fs from 'fs-extra';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';

const execAsync = promisify(exec);

const DockerfileSchema = z.object({
  dockerfile: z.string(),
  explanation: z.string(),
  buildSteps: z.array(z.string()),
});

const ErrorAnalysisSchema = z.object({
  errorType: z.string(),
  rootCause: z.string(),
  suggestedFix: z.string(),
  confidence: z.number().min(0).max(100),
  requiresManualIntervention: z.boolean(),
});

export class DeploymentAgent extends BaseAgent {
  private llm: ChatOpenAI;
  private workspaceDir: string;
  private maxRetries: number = 3;

  constructor(prisma: any, logger: any) {
    super(prisma, logger, 'Deployment');
    
    this.llm = new ChatOpenAI({
      modelName: 'gpt-4',
      temperature: 0.1,
    });

    this.workspaceDir = path.join(process.cwd(), 'workspace');
    fs.ensureDirSync(this.workspaceDir);
  }

  /**
   * Clone repository to local workspace
   */
  private async cloneRepository(repoUrl: string, deploymentId: string): Promise<string> {
    const repoPath = path.join(this.workspaceDir, deploymentId);
    
    // Clean up existing directory if it exists
    if (await fs.pathExists(repoPath)) {
      await fs.remove(repoPath);
    }

    const git = simpleGit();
    await git.clone(repoUrl, repoPath);
    
    return repoPath;
  }

  /**
   * Analyze repository structure and contents
   */
  private async analyzeRepository(repoPath: string): Promise<any> {
    const analysis: {
      packageJson: any;
      dockerfile: string | null;
      language: string;
      framework: string;
      files: string[];
      hasTests: boolean;
    } = {
      packageJson: null,
      dockerfile: null,
      language: 'unknown',
      framework: 'unknown',
      files: [],
      hasTests: false,
    };

    // Read directory structure
    const files = await this.getDirectoryStructure(repoPath);
    analysis.files = files;

    // Check for package.json (Node.js)
    const packageJsonPath = path.join(repoPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      analysis.packageJson = await fs.readJson(packageJsonPath);
      analysis.language = 'nodejs';
    }

    // Check for existing Dockerfile
    const dockerfilePath = path.join(repoPath, 'Dockerfile');
    if (await fs.pathExists(dockerfilePath)) {
      analysis.dockerfile = await fs.readFile(dockerfilePath, 'utf8');
    }

    // Detect framework
    if (analysis.packageJson) {
      const dependencies = {
        ...(analysis.packageJson.dependencies || {}),
        ...(analysis.packageJson.devDependencies || {}),
      };

      if (dependencies.express) analysis.framework = 'express';
      else if (dependencies.react) analysis.framework = 'react';
      else if (dependencies.next) analysis.framework = 'nextjs';
      else if (dependencies.vue) analysis.framework = 'vue';
    }

    // Check for tests
    analysis.hasTests = files.some(file => 
      file.includes('test') || file.includes('spec') || file.includes('__tests__')
    );

    return analysis;
  }

  /**
   * Get directory structure recursively
   */
  private async getDirectoryStructure(dirPath: string, relativePath: string = ''): Promise<string[]> {
    const files = [];
    const entries = await fs.readdir(dirPath);

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      
      const fullPath = path.join(dirPath, entry);
      const relativeFilePath = path.join(relativePath, entry);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory()) {
        files.push(relativeFilePath + '/');
        const subFiles = await this.getDirectoryStructure(fullPath, relativeFilePath);
        files.push(...subFiles);
      } else {
        files.push(relativeFilePath);
      }
    }

    return files;
  }

  /**
   * Generate Dockerfile using LLM
   */
  private async generateDockerfile(analysis: any): Promise<z.infer<typeof DockerfileSchema>> {
    const dockerfilePrompt = PromptTemplate.fromTemplate(`
      Generate a production-ready Dockerfile for the following application:

      Language: {language}
      Framework: {framework}
      Package.json: {packageJson}
      Files: {files}
      Has Tests: {hasTests}

      Requirements:
      - Use multi-stage builds for optimization
      - Include proper security practices (non-root user, minimal attack surface)
      - Optimize for layer caching
      - Include health checks if applicable
      - Expose appropriate ports
      - Handle environment variables properly

      Provide:
      1. Complete Dockerfile content
      2. Explanation of key decisions
      3. Build steps for the deployment process

      Format your response as JSON with keys: dockerfile, explanation, buildSteps
    `);

    const prompt = await dockerfilePrompt.format({
      language: analysis.language,
      framework: analysis.framework,
      packageJson: JSON.stringify(analysis.packageJson, null, 2),
      files: analysis.files.slice(0, 50).join('\n'), // Limit to avoid token limits
      hasTests: analysis.hasTests.toString(),
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    
    try {
      const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const parsed = JSON.parse(responseContent);
      return DockerfileSchema.parse(parsed);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to parse Dockerfile generation response: ${errorMessage}`);
    }
  }

  /**
   * Build Docker image
   */
  private async buildDockerImage(repoPath: string, deploymentId: string): Promise<string> {
    const imageName = `kairoz-app-${deploymentId.toLowerCase()}`;
    const buildCommand = `docker build -t ${imageName} ${repoPath}`;

    const { stdout, stderr } = await execAsync(buildCommand, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
    });

    return imageName;
  }

  /**
   * Analyze build errors and suggest fixes
   */
  private async analyzeBuildError(error: string, dockerfile: string): Promise<z.infer<typeof ErrorAnalysisSchema>> {
    const errorPrompt = PromptTemplate.fromTemplate(`
      Analyze the following Docker build error and suggest a fix:

      Build Error:
      {error}

      Current Dockerfile:
      {dockerfile}

      Provide:
      1. Error type classification
      2. Root cause analysis
      3. Specific fix suggestion
      4. Confidence level (0-100)
      5. Whether manual intervention is required

      Format as JSON with keys: errorType, rootCause, suggestedFix, confidence, requiresManualIntervention
    `);

    const prompt = await errorPrompt.format({
      error,
      dockerfile,
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    
    try {
      const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const parsed = JSON.parse(responseContent);
      return ErrorAnalysisSchema.parse(parsed);
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : 'Unknown error';
      throw new Error(`Failed to parse error analysis: ${errorMessage}`);
    }
  }

  /**
   * Apply fix to Dockerfile
   */
  private async applyDockerfileFix(repoPath: string, suggestedFix: string): Promise<void> {
    const fixPrompt = PromptTemplate.fromTemplate(`
      Apply this fix to the Dockerfile:
      {suggestedFix}

      Current Dockerfile:
      {currentDockerfile}

      Return only the complete corrected Dockerfile content.
    `);

    const dockerfilePath = path.join(repoPath, 'Dockerfile');
    const currentDockerfile = await fs.readFile(dockerfilePath, 'utf8');

    const prompt = await fixPrompt.format({
      suggestedFix,
      currentDockerfile,
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    await fs.writeFile(dockerfilePath, responseContent);
  }

  /**
   * Execute deployment with self-correction loop
   */
  async execute(taskId: string, input: any): Promise<any> {
    await this.updateTaskStatus(taskId, 'IN_PROGRESS');
    await this.logMessage(taskId, `Starting deployment for repository: ${input.repoUrl}`);

    const deploymentId = input.deploymentId || taskId;
    let attempt = 1;

    try {
      // Step 1: Clone repository
      await this.logMessage(taskId, 'Cloning repository...');
      const repoPath = await this.cloneRepository(input.repoUrl, deploymentId);

      // Step 2: Analyze repository
      await this.logMessage(taskId, 'Analyzing repository structure...');
      const analysis = await this.analyzeRepository(repoPath);
      
      // Step 3: Generate or use existing Dockerfile
      let dockerfile: string;
      if (analysis.dockerfile) {
        await this.logMessage(taskId, 'Using existing Dockerfile');
        dockerfile = analysis.dockerfile;
      } else {
        await this.logMessage(taskId, 'Generating Dockerfile with AI...');
        const dockerfileResult = await this.generateDockerfile(analysis);
        dockerfile = dockerfileResult.dockerfile;
        
        // Write generated Dockerfile
        const dockerfilePath = path.join(repoPath, 'Dockerfile');
        await fs.writeFile(dockerfilePath, dockerfile);
        
        await this.logMessage(taskId, `Generated Dockerfile: ${dockerfileResult.explanation}`);
      }

      // Step 4: Build with self-correction loop
      let imageName: string | undefined;
      let buildSuccess = false;

      while (attempt <= this.maxRetries && !buildSuccess) {
        try {
          await this.logMessage(taskId, `Build attempt ${attempt}/${this.maxRetries}`);
          imageName = await this.buildDockerImage(repoPath, deploymentId);
          buildSuccess = true;
          await this.logMessage(taskId, `Build successful: ${imageName}`);
        } catch (buildError) {
          const errorMessage = buildError instanceof Error ? buildError.message : 'Unknown build error';
          await this.logMessage(taskId, `Build failed on attempt ${attempt}: ${errorMessage}`, 'ERROR');
          
          if (attempt === this.maxRetries) {
            throw new Error(`Build failed after ${this.maxRetries} attempts: ${errorMessage}`);
          }

          // Analyze error and apply fix
          await this.logMessage(taskId, 'Analyzing build error with AI...');
          const errorAnalysis = await this.analyzeBuildError(errorMessage, dockerfile);
          
          if (errorAnalysis.requiresManualIntervention) {
            await this.updateTaskStatus(taskId, 'REQUIRES_MANUAL_ACTION', {
              error: errorMessage,
              analysis: errorAnalysis,
              repoPath,
            });
            return {
              status: 'REQUIRES_MANUAL_ACTION',
              message: errorAnalysis.suggestedFix,
              analysis: errorAnalysis,
            };
          }

          // Apply automatic fix
          await this.logMessage(taskId, `Applying fix: ${errorAnalysis.suggestedFix}`);
          await this.applyDockerfileFix(repoPath, errorAnalysis.suggestedFix);
          
          // Update dockerfile variable for next iteration
          const dockerfilePath = path.join(repoPath, 'Dockerfile');
          dockerfile = await fs.readFile(dockerfilePath, 'utf8');
          
          attempt = await this.incrementAttempts(taskId);
        }
      }

      if (!imageName) {
        throw new Error('Failed to build Docker image');
      }

      // Step 5: Deploy container (simplified - in production would involve orchestration)
      const containerName = `kairoz-${deploymentId}`;
      const runCommand = `docker run -d --name ${containerName} -p 80:3000 ${imageName}`;
      
      try {
        await execAsync(runCommand);
        await this.logMessage(taskId, `Container deployed: ${containerName}`);
      } catch (runError) {
        const errorMessage = runError instanceof Error ? runError.message : 'Unknown deployment error';
        await this.logMessage(taskId, `Container deployment failed: ${errorMessage}`, 'ERROR');
        throw new Error(errorMessage);
      }

      const result = {
        deploymentId,
        imageName,
        containerName,
        repoPath,
        analysis,
        attempts: attempt,
      };

      await this.updateTaskStatus(taskId, 'SUCCESS', result);
      await this.logMessage(taskId, 'Deployment completed successfully');

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown deployment error';
      await this.logMessage(taskId, `Deployment failed: ${errorMessage}`, 'ERROR');
      await this.updateTaskStatus(taskId, 'FAILED', { error: errorMessage });
      throw error;
    }
  }
}