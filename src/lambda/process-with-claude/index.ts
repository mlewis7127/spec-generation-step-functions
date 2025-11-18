import { Context } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { FileProcessingEvent, ClaudeRequest, ClaudeResponse, ProcessingError } from '../../shared/types';
import { 
  createProcessingError, 
  logInfo, 
  logError,
  logMetric,
  logPerformanceMetric
} from '../../shared/utils';
import { CLAUDE_CONFIG, ERROR_MESSAGES, RETRY_CONFIG } from '../../shared/constants';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Lambda function to process file content with Claude LLM via Amazon Bedrock
 * Handles prompt engineering and response validation
 */
export const handler = async (
  event: FileProcessingEvent | ProcessingError,
  context: Context
): Promise<{ generatedSpecification: string; metadata: any } | ProcessingError> => {
  const startTime = Date.now();
  logInfo('ProcessWithClaudeFunction started', { requestId: context.awsRequestId });
  logMetric('ProcessWithClaudeInvocations', 1);

  try {
    // Check if input event is an error from previous step
    if ('errorType' in event) {
      logError('Received error from previous step, passing through', event);
      return event;
    }

    const fileEvent = event as FileProcessingEvent;
    
    // Validate that we have the required content
    if (!fileEvent.content) {
      const error = createProcessingError(
        'CLAUDE_PROCESSING_ERROR',
        'No content received from ReadFileFunction',
        fileEvent.key || 'unknown',
        { receivedEvent: fileEvent }
      );
      logError('Missing content in file event', error);
      return error;
    }

    logInfo('Processing file content with Claude', { 
      originalFile: fileEvent.key,
      contentLength: fileEvent.content.length,
      fileType: fileEvent.fileType 
    });

    // Generate specification using Claude with retry logic
    const startTime = Date.now();
    const claudeResult = await processWithClaudeRetry(fileEvent, context);
    
    if ('errorType' in claudeResult) {
      return claudeResult;
    }

    const processingTime = (Date.now() - startTime) / 1000;
    
    // Log performance and token usage metrics
    logPerformanceMetric('ProcessWithClaude', startTime, {
      originalFile: fileEvent.key,
      outputLength: claudeResult.generatedSpecification.length,
      inputTokens: claudeResult.inputTokens,
      outputTokens: claudeResult.outputTokens
    });
    
    logMetric('ProcessWithClaudeSuccess', 1);
    logMetric('ClaudeInputTokens', claudeResult.inputTokens);
    logMetric('ClaudeOutputTokens', claudeResult.outputTokens);
    
    logInfo('Claude processing completed successfully', {
      originalFile: fileEvent.key,
      processingTimeSeconds: processingTime,
      outputLength: claudeResult.generatedSpecification.length
    });

    return {
      generatedSpecification: claudeResult.generatedSpecification,
      metadata: {
        originalFile: fileEvent.key,
        originalBucket: fileEvent.bucket,
        fileType: fileEvent.fileType,
        processingTimeSeconds: processingTime,
        inputTokens: claudeResult.inputTokens,
        outputTokens: claudeResult.outputTokens,
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    logMetric('ProcessWithClaudeErrors', 1);
    logPerformanceMetric('ProcessWithClaude', startTime, { error: true });
    
    const processingError = createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      `Unexpected error in ProcessWithClaudeFunction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'errorType' in event ? undefined : (event as FileProcessingEvent).key,
      error
    );
    logError('ProcessWithClaudeFunction failed with unexpected error', processingError);
    return processingError;
  }
};

/**
 * Process content with Claude using retry logic
 */
async function processWithClaudeRetry(
  fileEvent: FileProcessingEvent,
  context: Context
): Promise<{ generatedSpecification: string; inputTokens: number; outputTokens: number } | ProcessingError> {
  
  let lastError: any;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      logInfo(`Claude processing attempt ${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS}`, {
        originalFile: fileEvent.key
      });

      const result = await processWithClaude(fileEvent);
      
      if ('errorType' in result) {
        lastError = result;
        
        // Don't retry for certain error types
        if (result.details?.retryable === false) {
          logError('Non-retryable error encountered, stopping retries', result);
          return result;
        }
        
        if (attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
          const delay = RETRY_CONFIG.INITIAL_INTERVAL_SECONDS * Math.pow(RETRY_CONFIG.BACKOFF_RATE, attempt - 1);
          logInfo(`Retrying after ${delay} seconds`, { attempt, delay });
          await sleep(delay * 1000);
          continue;
        }
      } else {
        return result;
      }
      
    } catch (error) {
      lastError = error;
      logError(`Attempt ${attempt} failed`, error);
      
      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
        const delay = RETRY_CONFIG.INITIAL_INTERVAL_SECONDS * Math.pow(RETRY_CONFIG.BACKOFF_RATE, attempt - 1);
        await sleep(delay * 1000);
        continue;
      }
    }
  }

  // All retries exhausted
  return createProcessingError(
    'CLAUDE_PROCESSING_ERROR',
    `Failed to process with Claude after ${RETRY_CONFIG.MAX_ATTEMPTS} attempts`,
    fileEvent.key,
    lastError
  );
}

/**
 * Process file content with Claude LLM
 */
async function processWithClaude(
  fileEvent: FileProcessingEvent
): Promise<{ generatedSpecification: string; inputTokens: number; outputTokens: number } | ProcessingError> {
  
  try {
    // Create prompt based on file type and content
    const prompt = createSpecificationPrompt(fileEvent);
    
    // Prepare Claude request
    const claudeRequest: ClaudeRequest = {
      anthropic_version: CLAUDE_CONFIG.ANTHROPIC_VERSION,
      max_tokens: CLAUDE_CONFIG.MAX_TOKENS,
      temperature: CLAUDE_CONFIG.TEMPERATURE,
      system: CLAUDE_CONFIG.SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    logInfo('Sending request to Claude', {
      originalFile: fileEvent.key,
      promptLength: prompt.length,
      maxTokens: CLAUDE_CONFIG.MAX_TOKENS
    });

    // Invoke Claude via Bedrock
    const command = new InvokeModelCommand({
      modelId: process.env.CLAUDE_MODEL || 'anthropic.claude-3-5-sonnet-20250219-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(claudeRequest)
    });

    const response = await bedrockClient.send(command);
    
    if (!response.body) {
      return createProcessingError(
        'CLAUDE_PROCESSING_ERROR',
        'Empty response body from Bedrock',
        fileEvent.key,
        { retryable: true }
      );
    }

    // Parse Claude response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const claudeResponse = responseBody as ClaudeResponse;

    logInfo('Received response from Claude', {
      originalFile: fileEvent.key,
      inputTokens: claudeResponse.usage?.input_tokens,
      outputTokens: claudeResponse.usage?.output_tokens,
      stopReason: claudeResponse.stop_reason
    });

    // Validate and extract specification content
    const validationResult = validateClaudeResponse(claudeResponse, fileEvent.key);
    if (validationResult) {
      return validationResult;
    }

    const generatedSpecification = claudeResponse.content[0].text;

    // Validate generated markdown
    const markdownValidation = validateMarkdownSpecification(generatedSpecification, fileEvent.key);
    if (markdownValidation) {
      return markdownValidation;
    }

    return {
      generatedSpecification,
      inputTokens: claudeResponse.usage?.input_tokens || 0,
      outputTokens: claudeResponse.usage?.output_tokens || 0
    };

  } catch (error) {
    // Handle specific Bedrock/Claude errors
    if (error instanceof Error) {
      if (error.message.includes('ThrottlingException') || error.message.includes('rate limit')) {
        return createProcessingError(
          'CLAUDE_PROCESSING_ERROR',
          'Claude API rate limit exceeded',
          fileEvent.key,
          { error: error.message, retryable: true }
        );
      }
      
      if (error.message.includes('ValidationException')) {
        return createProcessingError(
          'CLAUDE_PROCESSING_ERROR',
          'Invalid request to Claude API',
          fileEvent.key,
          { error: error.message, retryable: false }
        );
      }
    }

    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      ERROR_MESSAGES.CLAUDE_API_ERROR,
      fileEvent.key,
      { error: error instanceof Error ? error.message : String(error), retryable: true }
    );
  }
}

/**
 * Create specification generation prompt based on file content and type
 */
function createSpecificationPrompt(fileEvent: FileProcessingEvent): string {
  const basePrompt = `Generate a comprehensive technical specification document in markdown format from the following content. 

The specification should include:
1. **Overview** - A clear summary of what the content describes
2. **Requirements** - Functional and non-functional requirements extracted from the content
3. **Technical Details** - Any technical specifications, architecture, or implementation details
4. **Additional Sections** - Any other relevant sections based on the content type

Guidelines:
- Use proper markdown formatting with headers, lists, and code blocks where appropriate
- Be comprehensive but concise
- Preserve important technical details and requirements
- Structure the information logically
- If the content is incomplete or unclear, note what additional information would be needed

Original file: ${fileEvent.key}
File type: ${fileEvent.fileType}
Content length: ${fileEvent.content.length} characters

Content to process:
---
${fileEvent.content}
---

Generate the specification document:`;

  return basePrompt;
}

/**
 * Validate Claude API response structure
 */
function validateClaudeResponse(response: ClaudeResponse, originalFile: string): ProcessingError | null {
  if (!response) {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Empty response', retryable: true }
    );
  }

  if (!response.content || !Array.isArray(response.content) || response.content.length === 0) {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Missing or empty content array', retryable: true }
    );
  }

  if (!response.content[0] || typeof response.content[0].text !== 'string') {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Missing or invalid text content', retryable: true }
    );
  }

  if (response.content[0].text.trim().length === 0) {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      'Claude returned empty specification content',
      originalFile,
      { retryable: true }
    );
  }

  return null;
}

/**
 * Validate generated markdown specification
 */
function validateMarkdownSpecification(specification: string, originalFile: string): ProcessingError | null {
  const trimmedSpec = specification.trim();
  
  // Check minimum length
  if (trimmedSpec.length < 100) {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      'Generated specification is too short to be meaningful',
      originalFile,
      { specificationLength: trimmedSpec.length, retryable: true }
    );
  }

  // Check for basic markdown structure (at least one header)
  if (!trimmedSpec.includes('#')) {
    return createProcessingError(
      'CLAUDE_PROCESSING_ERROR',
      'Generated specification lacks proper markdown structure (no headers found)',
      originalFile,
      { retryable: true }
    );
  }

  // Check for reasonable content (not just error messages or refusals)
  const lowerSpec = trimmedSpec.toLowerCase();
  const errorIndicators = [
    'i cannot',
    'i\'m unable',
    'i can\'t',
    'sorry, i cannot',
    'i don\'t have access',
    'i cannot process',
    'unable to generate'
  ];

  for (const indicator of errorIndicators) {
    if (lowerSpec.includes(indicator)) {
      return createProcessingError(
        'CLAUDE_PROCESSING_ERROR',
        'Claude was unable to process the content properly',
        originalFile,
        { reason: 'Claude refusal or inability', retryable: true }
      );
    }
  }

  return null;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}