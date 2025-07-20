import { BaseAgent } from './base-agent';
import { ChatOpenAI } from '@langchain/openai';
import { Pinecone } from '@pinecone-database/pinecone';
import { OpenAIEmbeddings } from '@langchain/openai';
import { PromptTemplate } from 'langchain/prompts';
import { HumanMessage } from 'langchain/schema';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const DiagnosisSchema = z.object({
  rootCause: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  category: z.string(),
  suggestion: z.string(),
  actionItems: z.array(z.string()),
  confidence: z.number().min(0).max(100),
  similarIncidents: z.array(z.string()).optional(),
});

interface IncidentContext {
  id: string;
  errorLog: string;
  rootCause: string;
  suggestion: string;
  category: string;
  timestamp: string;
  similarity?: number;
}

export class DiagnosisAgent extends BaseAgent {
  private llm: ChatOpenAI;
  private pinecone: Pinecone;
  private embeddings: OpenAIEmbeddings;
  private indexName: string;

  constructor(prisma: any, logger: any) {
    super(prisma, logger, 'Diagnosis');
    
    this.llm = new ChatOpenAI({
      modelName: 'gpt-4',
      temperature: 0.1,
    });

    this.embeddings = new OpenAIEmbeddings({
      modelName: 'text-embedding-ada-002',
    });

    this.pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!,
    });

    this.indexName = process.env.PINECONE_INDEX || 'kairoz-diagnoses';
  }

  /**
   * Retrieve similar incidents from vector database
   */
  private async retrieveSimilarIncidents(errorLog: string, topK: number = 5): Promise<IncidentContext[]> {
    try {
      const index = this.pinecone.index(this.indexName);
      
      // Create embedding for the error log
      const errorEmbedding = await this.embeddings.embedQuery(errorLog);
      
      // Query Pinecone for similar incidents
      const queryResponse = await index.query({
        vector: errorEmbedding,
        topK,
        includeMetadata: true,
        includeValues: false,
      });

      // Transform results to IncidentContext
      const incidents: IncidentContext[] = queryResponse.matches?.map(match => ({
        id: match.id,
        errorLog: match.metadata?.errorLog as string || '',
        rootCause: match.metadata?.rootCause as string || '',
        suggestion: match.metadata?.suggestion as string || '',
        category: match.metadata?.category as string || '',
        timestamp: match.metadata?.timestamp as string || '',
        similarity: match.score,
      })) || [];

      return incidents;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to retrieve similar incidents: ${errorMessage}`);
      return [];
    }
  }

  /**
   * Store new incident in vector database
   */
  private async storeIncident(
    incidentId: string,
    errorLog: string,
    diagnosis: z.infer<typeof DiagnosisSchema>
  ): Promise<void> {
    try {
      const index = this.pinecone.index(this.indexName);
      
      // Create embedding for the error log
      const errorEmbedding = await this.embeddings.embedQuery(errorLog);
      
      // Store in Pinecone
      await index.upsert([{
        id: incidentId,
        values: errorEmbedding,
        metadata: {
          errorLog: errorLog.substring(0, 8000), // Limit metadata size
          rootCause: diagnosis.rootCause,
          suggestion: diagnosis.suggestion,
          category: diagnosis.category,
          severity: diagnosis.severity,
          confidence: diagnosis.confidence,
          timestamp: new Date().toISOString(),
        },
      }]);

      this.logger.info(`Stored incident ${incidentId} in vector database`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to store incident in vector database: ${errorMessage}`);
    }
  }

  /**
   * Analyze error using LLM with RAG context
   */
  private async analyzeError(
    errorLog: string,
    similarIncidents: IncidentContext[],
    additionalContext?: any
  ): Promise<z.infer<typeof DiagnosisSchema>> {
    
    const contextString = similarIncidents.length > 0
      ? similarIncidents.map((incident, index) => 
          `Similar Incident ${index + 1} (Similarity: ${incident.similarity?.toFixed(2) || 'N/A'}):\n` +
          `Category: ${incident.category}\n` +
          `Root Cause: ${incident.rootCause}\n` +
          `Solution: ${incident.suggestion}\n` +
          `---`
        ).join('\n')
      : 'No similar incidents found in knowledge base.';

    const diagnosisPrompt = PromptTemplate.fromTemplate(`
      You are an expert DevOps engineer analyzing a deployment error. Use the error log and similar past incidents to provide a comprehensive diagnosis.

      Current Error Log:
      {errorLog}

      Additional Context:
      {additionalContext}

      Similar Past Incidents:
      {contextString}

      Provide a thorough analysis including:
      1. Root cause analysis
      2. Severity assessment (low, medium, high, critical)
      3. Error category (e.g., "build-error", "runtime-error", "configuration-error", "network-error")
      4. Detailed solution suggestion
      5. Step-by-step action items
      6. Confidence level in your diagnosis (0-100)

      Consider the similar incidents but adapt solutions to the current specific error.
      If no similar incidents exist, rely on your expertise to provide a comprehensive diagnosis.

      Format your response as JSON with the following structure:
      {{
        "rootCause": "detailed root cause analysis",
        "severity": "low|medium|high|critical",
        "category": "error category",
        "suggestion": "detailed solution suggestion",
        "actionItems": ["step 1", "step 2", "step 3"],
        "confidence": confidence_number,
        "similarIncidents": ["brief description of how similar incidents helped"]
      }}
    `);

    const prompt = await diagnosisPrompt.format({
      errorLog: errorLog.substring(0, 4000), // Limit to avoid token limits
      additionalContext: additionalContext ? JSON.stringify(additionalContext, null, 2) : 'None provided',
      contextString,
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    
    try {
      const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const parsed = JSON.parse(responseContent);
      return DiagnosisSchema.parse(parsed);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to parse diagnosis response: ${errorMessage}`);
    }
  }

  /**
   * Generate automated fix script
   */
  private async generateFixScript(
    diagnosis: z.infer<typeof DiagnosisSchema>,
    errorLog: string,
    containerName?: string
  ): Promise<string> {
    const fixPrompt = PromptTemplate.fromTemplate(`
      Generate a bash script to automatically fix the following issue:

      Root Cause: {rootCause}
      Suggestion: {suggestion}
      Action Items: {actionItems}
      Container Name: {containerName}
      
      The script should:
      1. Be safe and include error checking
      2. Be idempotent (can run multiple times safely)
      3. Include logging and status messages
      4. Handle common edge cases
      5. Exit with proper error codes

      Only generate fixes that are safe to automate. If manual intervention is required, 
      return a script that outputs instructions for the user.

      Return only the bash script content without any markdown formatting.
    `);

    const prompt = await fixPrompt.format({
      rootCause: diagnosis.rootCause,
      suggestion: diagnosis.suggestion,
      actionItems: diagnosis.actionItems.join(', '),
      containerName: containerName || 'unknown',
    });

    const response = await this.llm.call([new HumanMessage(prompt)]);
    const responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    return responseContent;
  }

  /**
   * Execute diagnosis and generate solution
   */
  async execute(taskId: string, input: any): Promise<any> {
    await this.updateTaskStatus(taskId, 'IN_PROGRESS');
    await this.logMessage(taskId, `Starting diagnosis for deployment: ${input.deploymentId || 'unknown'}`);

    try {
      const { deploymentId, error, logs, containerName, errorType } = input;
      const errorLog = logs || error || 'No error log provided';

      // Step 1: Retrieve similar incidents using RAG
      await this.logMessage(taskId, 'Retrieving similar incidents from knowledge base...');
      const similarIncidents = await this.retrieveSimilarIncidents(errorLog);
      
      if (similarIncidents.length > 0) {
        await this.logMessage(taskId, `Found ${similarIncidents.length} similar incidents`);
      } else {
        await this.logMessage(taskId, 'No similar incidents found, proceeding with fresh analysis');
      }

      // Step 2: Analyze error with LLM
      await this.logMessage(taskId, 'Analyzing error with AI...');
      const diagnosis = await this.analyzeError(errorLog, similarIncidents, {
        deploymentId,
        errorType,
        containerName,
        timestamp: new Date().toISOString(),
      });

      await this.logMessage(taskId, `Diagnosis complete - Severity: ${diagnosis.severity}, Confidence: ${diagnosis.confidence}%`);

      // Step 3: Generate fix script
      await this.logMessage(taskId, 'Generating automated fix script...');
      const fixScript = await this.generateFixScript(diagnosis, errorLog, containerName);

      // Step 4: Save diagnosis to database
      const savedDiagnosis = await this.prisma.diagnosis.create({
        data: {
          deploymentId: deploymentId || taskId,
          errorLog,
          rootCause: diagnosis.rootCause,
          suggestion: diagnosis.suggestion,
          retrievedContextIds: similarIncidents.map(incident => incident.id),
        },
      });

      // Step 5: Store incident in vector database for future learning
      const incidentId = uuidv4();
      await this.storeIncident(incidentId, errorLog, diagnosis);
      await this.logMessage(taskId, `Stored incident ${incidentId} for future learning`);

      const result = {
        diagnosisId: savedDiagnosis.id,
        deploymentId,
        diagnosis,
        fixScript,
        similarIncidentsCount: similarIncidents.length,
        incidentId,
        timestamp: new Date().toISOString(),
      };

      await this.updateTaskStatus(taskId, 'SUCCESS', result);
      await this.logMessage(taskId, 'Diagnosis completed successfully');

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown diagnosis error';
      await this.logMessage(taskId, `Diagnosis failed: ${errorMessage}`, 'ERROR');
      await this.updateTaskStatus(taskId, 'FAILED', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Get historical diagnoses for a deployment
   */
  async getHistoricalDiagnoses(deploymentId: string): Promise<any[]> {
    return await this.prisma.diagnosis.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  /**
   * Search incidents by category or keywords
   */
  async searchIncidents(query: string, limit: number = 10): Promise<IncidentContext[]> {
    return await this.retrieveSimilarIncidents(query, limit);
  }

  /**
   * Get diagnosis statistics
   */
  async getDiagnosisStats(): Promise<any> {
    const total = await this.prisma.diagnosis.count();
    const recentCount = await this.prisma.diagnosis.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        },
      },
    });

    return {
      totalDiagnoses: total,
      recentDiagnoses: recentCount,
      knowledgeBaseSize: total, // Approximate - actual size would need Pinecone query
    };
  }
}