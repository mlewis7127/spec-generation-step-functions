import { Context } from 'aws-lambda';
import { S3 } from 'aws-sdk';
import { FileProcessingEvent, ProcessingError } from '../../shared/types';
import {
  validateFileSize,
  isSupportedFileFormat,
  createProcessingError,
  logInfo,
  logError,
  logMetric,
  logPerformanceMetric,
  createXRaySubsegment,
  addXRayAnnotations,
  addXRayMetadata,
  getFileExtension
} from '../../shared/utils';
import { S3_CONFIG, ERROR_MESSAGES, SUPPORTED_FILE_FORMATS, CONTENT_VALIDATION } from '../../shared/constants';

const s3 = new S3();

// Step Functions input format from EventBridge S3 events
interface StepFunctionsS3Event {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  eventTime: string;
  eventName: string;
}

/**
 * Lambda function to read files from S3 input bucket
 * Handles file format validation and size checking
 * Receives S3 file references from Step Functions (not file content)
 */
export const handler = async (event: StepFunctionsS3Event, context: Context): Promise<FileProcessingEvent | ProcessingError> => {
  const startTime = Date.now();
  logInfo('ReadFileFunction started', { requestId: context.awsRequestId });
  logMetric('ReadFileInvocations', 1);

  try {
    // Extract S3 event details from Step Functions input
    if (!event.bucket || !event.key) {
      throw new Error('Missing required S3 bucket or key in event');
    }

    const bucket = event.bucket;
    const key = decodeURIComponent(event.key.replace(/\+/g, ' '));
    const size = event.size;
    const etag = event.etag;

    logInfo('Processing file', { bucket, key, size });

    // Add X-Ray annotations for better trace filtering
    addXRayAnnotations({
      fileType: getFileExtension(key),
      fileSize: size,
      bucket: bucket,
    });

    // Add X-Ray metadata for additional context
    addXRayMetadata('file-processing', {
      originalFile: key,
      fileSizeBytes: size,
      processingStartTime: new Date().toISOString(),
    });

    // Validate file size
    if (!validateFileSize(size, S3_CONFIG.MAX_FILE_SIZE_BYTES)) {
      const error = createProcessingError(
        'FILE_READ_ERROR',
        ERROR_MESSAGES.FILE_TOO_LARGE,
        key,
        { actualSize: size, maxSize: S3_CONFIG.MAX_FILE_SIZE_BYTES }
      );
      logError('File size validation failed', error);
      return error;
    }

    // Additional check for Step Functions payload limit (256KB)
    // Leave buffer for metadata and other state data
    if (size > S3_CONFIG.STEP_FUNCTIONS_PAYLOAD_LIMIT) {
      const error = createProcessingError(
        'FILE_TOO_LARGE_FOR_STEP_FUNCTIONS',
        `File size (${size} bytes) exceeds Step Functions payload limit. Maximum supported size is ${S3_CONFIG.STEP_FUNCTIONS_PAYLOAD_LIMIT} bytes.`,
        key,
        { actualSize: size, maxSize: S3_CONFIG.STEP_FUNCTIONS_PAYLOAD_LIMIT }
      );
      logError('File exceeds Step Functions payload limit', error);
      return error;
    }

    // Validate file format
    if (!isSupportedFileFormat(key)) {
      const extension = getFileExtension(key);
      const error = createProcessingError(
        'FILE_READ_ERROR',
        ERROR_MESSAGES.UNSUPPORTED_FORMAT,
        key,
        {
          actualFormat: extension,
          supportedFormats: SUPPORTED_FILE_FORMATS
        }
      );
      logError('File format validation failed', error);
      return error;
    }

    // Read file content from S3
    let fileContent: string;
    let processedContent: string;
    try {
      const s3Object = await createXRaySubsegment('s3-get-object', async () => {
        return s3.getObject({
          Bucket: bucket,
          Key: key
        }).promise();
      });

      if (!s3Object.Body) {
        throw new Error('File body is empty');
      }

      const extension = getFileExtension(key);

      // Process content based on file type
      const body = s3Object.Body as Buffer;
      const contentResult = await processFileContent(body, extension, key);
      if (contentResult.error) {
        return contentResult.error;
      }

      fileContent = contentResult.rawContent;
      processedContent = contentResult.processedContent;

      // Validate processed content
      const validationResult = validateProcessedContent(processedContent, key);
      if (validationResult) {
        return validationResult;
      }

      logInfo('File content extracted and processed successfully', {
        rawContentLength: fileContent.length,
        processedContentLength: processedContent.length,
        fileType: extension
      });

    } catch (s3Error) {
      const error = createProcessingError(
        'FILE_READ_ERROR',
        ERROR_MESSAGES.S3_READ_ERROR,
        key,
        s3Error
      );
      logError('S3 read operation failed', error);
      return error;
    }

    // Create successful processing event
    const processingEvent: FileProcessingEvent = {
      bucket,
      key,
      size,
      timestamp: new Date().toISOString(),
      etag,
      content: processedContent,
      fileType: getFileExtension(key)
    };

    // Log performance metrics
    logPerformanceMetric('ReadFile', startTime, {
      fileProcessed: key,
      contentSize: processedContent.length,
      fileType: getFileExtension(key)
    });

    logMetric('ReadFileSuccess', 1);
    logInfo('ReadFileFunction completed successfully', {
      fileProcessed: key,
      contentSize: processedContent.length
    });

    return processingEvent;

  } catch (error) {
    logMetric('ReadFileErrors', 1);
    logPerformanceMetric('ReadFile', startTime, { error: true });

    const processingError = createProcessingError(
      'FILE_READ_ERROR',
      `Unexpected error in ReadFileFunction: ${error instanceof Error ? error.message : 'Unknown error'}`,
      undefined,
      error
    );
    logError('ReadFileFunction failed with unexpected error', processingError);
    return processingError;
  }
};

/**
 * Process file content based on file type
 */
async function processFileContent(
  body: Buffer,
  fileType: string,
  filename: string
): Promise<{ rawContent: string; processedContent: string; error?: ProcessingError }> {

  try {
    let rawContent: string;
    let processedContent: string;

    switch (fileType) {
      case 'txt':
      case 'md':
      case 'java':
      case 'rexx':
      case 'py':
      case 'js':
      case 'ts':
        // Plain text files and source code files - direct UTF-8 conversion
        rawContent = body.toString('utf-8');
        processedContent = cleanTextContent(rawContent);
        break;

      case 'rtf':
        // RTF files - extract plain text (basic implementation)
        rawContent = body.toString('utf-8');
        processedContent = extractRTFText(rawContent);
        break;

      case 'pdf':
        // PDF files - for now, store as base64 and add placeholder text
        rawContent = body.toString('base64');
        processedContent = `[PDF Content - ${filename}]\nNote: PDF content extraction requires additional processing. File stored as base64 for downstream processing.`;
        logInfo('PDF file detected - basic processing applied', { filename });
        break;

      case 'doc':
      case 'docx':
        // DOC/DOCX files - for now, store as base64 and add placeholder text
        rawContent = body.toString('base64');
        processedContent = `[Document Content - ${filename}]\nNote: Document content extraction requires additional processing. File stored as base64 for downstream processing.`;
        logInfo('Document file detected - basic processing applied', { filename, type: fileType });
        break;

      default:
        // Fallback for unsupported formats
        const error = createProcessingError(
          'FILE_READ_ERROR',
          `Unsupported file type for content processing: ${fileType}`,
          filename,
          { fileType }
        );
        return { rawContent: '', processedContent: '', error };
    }

    return { rawContent, processedContent };

  } catch (error) {
    const processingError = createProcessingError(
      'FILE_READ_ERROR',
      `Failed to process content for file type ${fileType}`,
      filename,
      error
    );
    return { rawContent: '', processedContent: '', error: processingError };
  }
}

/**
 * Clean and normalize text content
 */
function cleanTextContent(content: string): string {
  return content
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    // Trim leading/trailing whitespace
    .trim();
}

/**
 * Extract plain text from RTF content (basic implementation)
 */
function extractRTFText(rtfContent: string): string {
  try {
    // Basic RTF text extraction - remove RTF control codes
    let text = rtfContent
      // Remove RTF header and control words
      .replace(/\\[a-z]+\d*\s?/gi, '')
      // Remove braces
      .replace(/[{}]/g, '')
      // Clean up whitespace
      .replace(/\s+/g, ' ')
      .trim();

    return cleanTextContent(text);
  } catch (error) {
    logError('RTF text extraction failed, returning raw content', error);
    return rtfContent;
  }
}

/**
 * Validate processed content meets minimum requirements
 */
function validateProcessedContent(content: string, filename: string): ProcessingError | null {
  // Check if content is empty or too short
  if (!content || content.trim().length === 0) {
    return createProcessingError(
      'FILE_READ_ERROR',
      'Processed content is empty',
      filename,
      { contentLength: content.length }
    );
  }

  // Check minimum content length
  if (content.trim().length < CONTENT_VALIDATION.MIN_CONTENT_LENGTH) {
    return createProcessingError(
      'FILE_READ_ERROR',
      'Processed content is too short for meaningful processing',
      filename,
      { contentLength: content.length, minLength: CONTENT_VALIDATION.MIN_CONTENT_LENGTH }
    );
  }

  // Check maximum content length (prevent excessive processing)
  if (content.length > CONTENT_VALIDATION.MAX_CONTENT_LENGTH) {
    return createProcessingError(
      'FILE_READ_ERROR',
      'Processed content exceeds maximum length for processing',
      filename,
      { contentLength: content.length, maxLength: CONTENT_VALIDATION.MAX_CONTENT_LENGTH }
    );
  }

  return null;
}