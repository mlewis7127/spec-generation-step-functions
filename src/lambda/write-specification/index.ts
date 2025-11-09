import { Context } from 'aws-lambda';
import { S3 } from 'aws-sdk';
import { ProcessingError, SpecificationOutput } from '../../shared/types';
import { 
  generateOutputPath,
  createProcessingError, 
  createProcessingStatus,
  createProcessingMetadata,
  validateOutputPath,
  logInfo, 
  logError,
  logMetric,
  logPerformanceMetric
} from '../../shared/utils';
import { ERROR_MESSAGES, RETRY_CONFIG } from '../../shared/constants';

const s3 = new S3();

interface WriteSpecificationInput {
  generatedSpecification: string;
  metadata: {
    originalFile: string;
    originalBucket: string;
    fileType: string;
    processingTimeSeconds: number;
    inputTokens: number;
    outputTokens: number;
    timestamp: string;
  };
}

/**
 * Lambda function to write generated specifications to S3 output bucket
 * Handles filename generation, date-based folder structure, and metadata preservation
 */
export const handler = async (
  event: WriteSpecificationInput | ProcessingError,
  context: Context
): Promise<SpecificationOutput | ProcessingError> => {
  const startTime = Date.now();
  logInfo('WriteSpecificationFunction started', { requestId: context.awsRequestId });
  logMetric('WriteSpecificationInvocations', 1);

  try {
    // Check if input event is an error from previous step
    if ('errorType' in event) {
      logError('Received error from previous step, passing through', event);
      return event;
    }

    const input = event as WriteSpecificationInput;
    
    logInfo('Writing specification to output bucket', {
      originalFile: input.metadata.originalFile,
      specificationLength: input.generatedSpecification.length,
      processingTime: input.metadata.processingTimeSeconds
    });

    // Write specification with retry logic
    const startTime = Date.now();
    const writeResult = await writeSpecificationWithRetry(input, context);
    
    if ('errorType' in writeResult) {
      return writeResult;
    }

    const writeTime = (Date.now() - startTime) / 1000;
    
    // Log performance metrics
    logPerformanceMetric('WriteSpecification', startTime, {
      originalFile: input.metadata.originalFile,
      outputLocation: writeResult.outputLocation,
      wordCount: writeResult.wordCount
    });
    
    logMetric('WriteSpecificationSuccess', 1);
    logMetric('SpecificationWordCount', writeResult.wordCount || 0);
    
    logInfo('Specification written successfully', {
      originalFile: input.metadata.originalFile,
      outputLocation: writeResult.outputLocation,
      writeTimeSeconds: writeTime
    });

    return writeResult;

  } catch (error) {
    logMetric('WriteSpecificationErrors', 1);
    logPerformanceMetric('WriteSpecification', startTime, { error: true });
    
    const processingError = createProcessingError(
      'OUTPUT_WRITE_ERROR',
      `Unexpected error in WriteSpecificationFunction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'errorType' in event ? undefined : (event as WriteSpecificationInput).metadata.originalFile,
      error
    );
    logError('WriteSpecificationFunction failed with unexpected error', processingError);
    return processingError;
  }
};

/**
 * Write specification to S3 with retry logic
 */
async function writeSpecificationWithRetry(
  input: WriteSpecificationInput,
  _context: Context
): Promise<SpecificationOutput | ProcessingError> {
  
  let lastError: any;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      logInfo(`Write attempt ${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS}`, {
        originalFile: input.metadata.originalFile
      });

      const result = await writeSpecificationToS3(input);
      
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
    'OUTPUT_WRITE_ERROR',
    `Failed to write specification after ${RETRY_CONFIG.MAX_ATTEMPTS} attempts`,
    input.metadata.originalFile,
    lastError
  );
}/**
 *
 Write specification to S3 output bucket
 */
async function writeSpecificationToS3(
  input: WriteSpecificationInput
): Promise<SpecificationOutput | ProcessingError> {
  
  try {
    const outputBucket = process.env.OUTPUT_BUCKET_NAME;
    if (!outputBucket) {
      return createProcessingError(
        'OUTPUT_WRITE_ERROR',
        'OUTPUT_BUCKET_NAME environment variable not set',
        input.metadata.originalFile,
        { retryable: false }
      );
    }

    // Generate output path with date-based folder structure
    const outputPath = generateOutputPath(input.metadata.originalFile);
    
    logInfo('Generated output path', {
      originalFile: input.metadata.originalFile,
      outputPath,
      outputBucket
    });

    // Prepare specification content with metadata header
    const specificationWithMetadata = addMetadataHeader(input.generatedSpecification, input.metadata);
    
    // Validate output path format
    if (!validateOutputPath(outputPath)) {
      return createProcessingError(
        'OUTPUT_WRITE_ERROR',
        'Generated output path does not match expected format',
        input.metadata.originalFile,
        { outputPath, retryable: false }
      );
    }

    // Calculate word count for the specification
    const wordCount = countWords(input.generatedSpecification);

    // Create comprehensive metadata
    const s3Metadata = createProcessingMetadata(
      input.metadata.originalFile,
      input.metadata.originalBucket,
      input.metadata.fileType,
      input.metadata.processingTimeSeconds,
      input.metadata.inputTokens,
      input.metadata.outputTokens,
      wordCount
    );

    // Write to S3 with metadata
    const putObjectParams = {
      Bucket: outputBucket,
      Key: outputPath,
      Body: specificationWithMetadata,
      ContentType: 'text/markdown',
      Metadata: s3Metadata,
      ServerSideEncryption: 'AES256' // Ensure encryption as per requirements
    };

    logInfo('Writing specification to S3', {
      bucket: outputBucket,
      key: outputPath,
      contentLength: specificationWithMetadata.length,
      wordCount
    });

    await s3.putObject(putObjectParams).promise();

    // Create processing status for success tracking
    const processingStatus = createProcessingStatus(
      input.metadata.originalFile,
      'success',
      `s3://${outputBucket}/${outputPath}`
    );

    // Create successful output result
    const specificationOutput: SpecificationOutput = {
      originalFile: input.metadata.originalFile,
      generatedAt: input.metadata.timestamp,
      outputLocation: `s3://${outputBucket}/${outputPath}`,
      processingTimeSeconds: input.metadata.processingTimeSeconds,
      wordCount,
      processingId: s3Metadata['processing-id'],
      fileType: input.metadata.fileType,
      inputTokens: input.metadata.inputTokens,
      outputTokens: input.metadata.outputTokens
    };

    logInfo('Specification written successfully to S3', {
      originalFile: input.metadata.originalFile,
      outputLocation: specificationOutput.outputLocation,
      wordCount,
      processingStatus
    });

    return specificationOutput;

  } catch (error) {
    // Handle specific S3 errors
    if (error instanceof Error) {
      if (error.message.includes('NoSuchBucket')) {
        return createProcessingError(
          'OUTPUT_WRITE_ERROR',
          'Output S3 bucket does not exist',
          input.metadata.originalFile,
          { error: error.message, retryable: false }
        );
      }
      
      if (error.message.includes('AccessDenied')) {
        return createProcessingError(
          'OUTPUT_WRITE_ERROR',
          'Access denied to output S3 bucket',
          input.metadata.originalFile,
          { error: error.message, retryable: false }
        );
      }

      if (error.message.includes('ServiceUnavailable') || error.message.includes('SlowDown')) {
        return createProcessingError(
          'OUTPUT_WRITE_ERROR',
          'S3 service temporarily unavailable',
          input.metadata.originalFile,
          { error: error.message, retryable: true }
        );
      }
    }

    // Create processing status for failure tracking
    const processingStatus = createProcessingStatus(
      input.metadata.originalFile,
      'failure',
      undefined,
      error instanceof Error ? error.message : String(error)
    );

    logError('Failed to write specification to S3', { processingStatus });

    return createProcessingError(
      'OUTPUT_WRITE_ERROR',
      ERROR_MESSAGES.S3_WRITE_ERROR,
      input.metadata.originalFile,
      { 
        error: error instanceof Error ? error.message : String(error), 
        retryable: true,
        processingStatus 
      }
    );
  }
}

/**
 * Add metadata header to the generated specification
 */
function addMetadataHeader(specification: string, metadata: any): string {
  const header = `---
# Generated Specification Document

**Original File:** ${metadata.originalFile}  
**Generated At:** ${metadata.timestamp}  
**Processing Time:** ${metadata.processingTimeSeconds} seconds  
**File Type:** ${metadata.fileType}  
**Input Tokens:** ${metadata.inputTokens}  
**Output Tokens:** ${metadata.outputTokens}  

---

`;

  return header + specification;
}

/**
 * Count words in the specification content
 */
function countWords(text: string): number {
  // Remove markdown formatting and count words
  const cleanText = text
    .replace(/[#*`_~\[\]()]/g, '') // Remove markdown characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  if (!cleanText) return 0;
  
  return cleanText.split(' ').filter(word => word.length > 0).length;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}