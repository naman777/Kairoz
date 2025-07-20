import { Status, LogLevel } from "../generated/prisma";

export interface DeploymentCommand {
  action: "deploy" | "monitor" | "diagnose" | "stop";
  repoUrl?: string;
  domain?: string;
  deploymentId?: string;
  metadata?: Record<string, any>;
}

export interface AgentContext {
  deploymentId: string;
  taskId: string;
  input: any;
  metadata?: Record<string, any>;
}

export interface AgentResult {
  success: boolean;
  output?: any;
  error?: string;
  nextAgent?: string;
  requiresManualAction?: boolean;
  manualActionMessage?: string;
}

export interface LogEntry {
  type: LogLevel;
  message: string;
  metadata?: Record<string, any>;
}

export interface DiagnosisResult {
  rootCause: string;
  suggestion: string;
  confidence: number;
  retrievedContextIds: string[];
}

export interface FileAnalysis {
  packageJson?: any;
  dockerfile?: string;
  hasDockerfile: boolean;
  framework?: string;
  dependencies: string[];
  scripts: Record<string, string>;
}

export interface BuildResult {
  success: boolean;
  imageId?: string;
  error?: string;
  logs: string[];
}

export { Status, LogLevel };
