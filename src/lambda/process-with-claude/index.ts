import { Context } from 'aws-lambda';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { FileProcessingEvent, ConverseMessage, ConverseResponse, ProcessingError } from '../../shared/types';
import { 
  createProcessingError, 
  logInfo, 
  logError,
  logMetric,
  logPerformanceMetric
} from '../../shared/utils';
import { LLM_CONFIG, ERROR_MESSAGES, RETRY_CONFIG } from '../../shared/constants';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Lambda function to process file content with LLM via Amazon Bedrock
 * Handles prompt engineering and response validation
 * Supports any Bedrock model (Claude, Nova, etc.)
 */
export const handler = async (
  event: FileProcessingEvent | ProcessingError,
  context: Context
): Promise<{ generatedSpecification: string; metadata: any } | ProcessingError> => {
  const startTime = Date.now();
  logInfo('ProcessWithLLM function started', { requestId: context.awsRequestId });
  logMetric('LLMProcessingInvocations', 1);

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
        'LLM_PROCESSING_ERROR',
        'No content received from ReadFileFunction',
        fileEvent.key || 'unknown',
        { receivedEvent: fileEvent }
      );
      logError('Missing content in file event', error);
      return error;
    }

    logInfo('Processing file content with LLM', { 
      originalFile: fileEvent.key,
      contentLength: fileEvent.content.length,
      fileType: fileEvent.fileType 
    });

    // Generate specification using LLM with retry logic
    const processingStartTime = Date.now();
    const result = await processWithLLMRetry(fileEvent);
    
    if ('errorType' in result) {
      return result;
    }

    const processingTime = (Date.now() - processingStartTime) / 1000;
    
    // Log performance and token usage metrics
    logPerformanceMetric('ProcessWithLLM', processingStartTime, {
      originalFile: fileEvent.key,
      outputLength: result.generatedSpecification.length,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens
    });
    
    logMetric('LLMProcessingSuccess', 1);
    logMetric('LLMInputTokens', result.inputTokens);
    logMetric('LLMOutputTokens', result.outputTokens);
    
    logInfo('LLM processing completed successfully', {
      originalFile: fileEvent.key,
      processingTimeSeconds: processingTime,
      outputLength: result.generatedSpecification.length
    });

    return {
      generatedSpecification: result.generatedSpecification,
      metadata: {
        originalFile: fileEvent.key,
        originalBucket: fileEvent.bucket,
        fileType: fileEvent.fileType,
        processingTimeSeconds: processingTime,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    logMetric('LLMProcessingErrors', 1);
    logPerformanceMetric('ProcessWithLLM', startTime, { error: true });
    
    const processingError = createProcessingError(
      'LLM_PROCESSING_ERROR',
      `Unexpected error in ProcessWithLLM function: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'errorType' in event ? undefined : (event as FileProcessingEvent).key,
      error
    );
    logError('ProcessWithLLM function failed with unexpected error', processingError);
    return processingError;
  }
};

/**
 * Process content with LLM using retry logic
 */
async function processWithLLMRetry(
  fileEvent: FileProcessingEvent
): Promise<{ generatedSpecification: string; inputTokens: number; outputTokens: number } | ProcessingError> {
  
  let lastError: any;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      logInfo(`LLM processing attempt ${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS}`, {
        originalFile: fileEvent.key
      });

      const result = await processWithLLM(fileEvent);
      
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
    'LLM_PROCESSING_ERROR',
    `Failed to process with LLM after ${RETRY_CONFIG.MAX_ATTEMPTS} attempts`,
    fileEvent.key,
    lastError
  );
}

/**
 * Process file content with LLM via Bedrock Converse API
 */
async function processWithLLM(
  fileEvent: FileProcessingEvent
): Promise<{ generatedSpecification: string; inputTokens: number; outputTokens: number } | ProcessingError> {
  
  try {
    // Create prompt based on file type and content
    const prompt = createSpecificationPrompt(fileEvent);
    
    // Get model ID from environment or use default
    const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20250219-v1:0';
    
    // Prepare messages in Converse API format
    const messages: ConverseMessage[] = [
      {
        role: 'user',
        content: [{ text: prompt }]
      }
    ];

    logInfo('Sending request to Bedrock', {
      originalFile: fileEvent.key,
      promptLength: prompt.length,
      maxTokens: LLM_CONFIG.MAX_TOKENS,
      modelId
    });

    // Invoke model via Bedrock Converse API
    const command = new ConverseCommand({
      modelId,
      messages,
      system: [{ text: LLM_CONFIG.SYSTEM_PROMPT }],
      inferenceConfig: {
        maxTokens: LLM_CONFIG.MAX_TOKENS,
        temperature: LLM_CONFIG.TEMPERATURE
      }
    });

    const response = await bedrockClient.send(command);
    
    if (!response.output?.message) {
      return createProcessingError(
        'LLM_PROCESSING_ERROR',
        'Empty response from Bedrock',
        fileEvent.key,
        { retryable: true }
      );
    }

    const converseResponse = response as ConverseResponse;

    logInfo('Received response from Bedrock', {
      originalFile: fileEvent.key,
      inputTokens: converseResponse.usage?.inputTokens,
      outputTokens: converseResponse.usage?.outputTokens,
      stopReason: converseResponse.stopReason
    });

    // Validate and extract specification content
    const validationResult = validateLLMResponse(converseResponse, fileEvent.key);
    if (validationResult) {
      return validationResult;
    }

    const generatedSpecification = converseResponse.output.message.content[0].text;

    // Validate generated markdown
    const markdownValidation = validateMarkdownSpecification(generatedSpecification, fileEvent.key);
    if (markdownValidation) {
      return markdownValidation;
    }

    return {
      generatedSpecification,
      inputTokens: converseResponse.usage?.inputTokens || 0,
      outputTokens: converseResponse.usage?.outputTokens || 0
    };

  } catch (error) {
    // Handle specific Bedrock errors
    if (error instanceof Error) {
      if (error.message.includes('ThrottlingException') || error.message.includes('rate limit')) {
        return createProcessingError(
          'LLM_PROCESSING_ERROR',
          'Bedrock API rate limit exceeded',
          fileEvent.key,
          { error: error.message, retryable: true }
        );
      }
      
      if (error.message.includes('ValidationException')) {
        return createProcessingError(
          'LLM_PROCESSING_ERROR',
          'Invalid request to Bedrock API',
          fileEvent.key,
          { error: error.message, retryable: false }
        );
      }
    }

    return createProcessingError(
      'LLM_PROCESSING_ERROR',
      ERROR_MESSAGES.LLM_API_ERROR,
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
 * Validate Bedrock Converse API response structure
 */
function validateLLMResponse(response: ConverseResponse, originalFile: string): ProcessingError | null {
  if (!response) {
    return createProcessingError(
      'LLM_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Empty response', retryable: true }
    );
  }

  if (!response.output?.message?.content || !Array.isArray(response.output.message.content) || response.output.message.content.length === 0) {
    return createProcessingError(
      'LLM_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Missing or empty content array', retryable: true }
    );
  }

  if (!response.output.message.content[0] || typeof response.output.message.content[0].text !== 'string') {
    return createProcessingError(
      'LLM_PROCESSING_ERROR',
      ERROR_MESSAGES.INVALID_RESPONSE,
      originalFile,
      { reason: 'Missing or invalid text content', retryable: true }
    );
  }

  if (response.output.message.content[0].text.trim().length === 0) {
    return createProcessingError(
      'LLM_PROCESSING_ERROR',
      'LLM returned empty specification content',
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
      'LLM_PROCESSING_ERROR',
      'Generated specification is too short to be meaningful',
      originalFile,
      { specificationLength: trimmedSpec.length, retryable: true }
    );
  }

  // Check for basic markdown structure (at least one header)
  if (!trimmedSpec.includes('#')) {
    return createProcessingError(
      'LLM_PROCESSING_ERROR',
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
        'LLM_PROCESSING_ERROR',
        'LLM was unable to process the content properly',
        originalFile,
        { reason: 'Model refusal or inability', retryable: true }
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