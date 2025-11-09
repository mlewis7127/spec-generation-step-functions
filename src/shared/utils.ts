/**
 * Shared utility functions for the S3 Specification Generator
 */

import { ProcessingError } from './types';

// X-Ray tracing setup
let AWSXRay: any;
try {
  AWSXRay = require('aws-xray-sdk-core');
  // Capture AWS SDK calls
  const AWS = AWSXRay.captureAWS(require('aws-sdk'));
} catch (error) {
  // X-Ray SDK not available in development environment
  console.log('X-Ray SDK not available, tracing disabled');
}

/**
 * Generate a timestamp-based filename for output specifications
 */
export function generateOutputFilename(originalFilename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').replace(/T/, '-').replace(/Z/, '');
  const baseName = originalFilename.replace(/\.[^/.]+$/, ''); // Remove extension
  return `${baseName}-${timestamp}.md`;
}

/**
 * Generate date-based folder structure for S3 output organization
 */
export function generateDateBasedPath(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * Generate complete S3 output path with date-based folder structure
 */
export function generateOutputPath(originalFilename: string): string {
  const datePath = generateDateBasedPath();
  const outputFilename = generateOutputFilename(originalFilename);
  return `${datePath}/${outputFilename}`;
}

/**
 * Validate file size against maximum allowed size
 */
export function validateFileSize(fileSize: number, maxSize: number): boolean {
  return fileSize <= maxSize;
}

/**
 * Extract file extension from filename
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

/**
 * Check if file format is supported
 */
export function isSupportedFileFormat(filename: string): boolean {
  const { SUPPORTED_FILE_FORMATS } = require('./constants');
  const extension = getFileExtension(filename);
  return SUPPORTED_FILE_FORMATS.includes(extension);
}

/**
 * Create standardized error object
 */
export function createProcessingError(
  errorType: ProcessingError['errorType'],
  message: string,
  originalFile?: string,
  details?: any
): ProcessingError {
  return {
    errorType,
    message,
    timestamp: new Date().toISOString(),
    originalFile,
    details,
  };
}

/**
 * Log structured information for CloudWatch with custom metrics
 */
export function logInfo(message: string, data?: any): void {
  const logEntry = {
    level: 'INFO',
    message,
    timestamp: new Date().toISOString(),
    data,
    requestId: process.env.AWS_REQUEST_ID,
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
  };
  
  console.log(JSON.stringify(logEntry));
}

/**
 * Log structured errors for CloudWatch with custom metrics
 */
export function logError(message: string, error?: any): void {
  const logEntry = {
    level: 'ERROR',
    message,
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error,
    requestId: process.env.AWS_REQUEST_ID,
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    functionVersion: process.env.AWS_LAMBDA_FUNCTION_VERSION,
  };
  
  console.error(JSON.stringify(logEntry));
}

/**
 * Log custom metrics for CloudWatch monitoring
 */
export function logMetric(metricName: string, value: number, unit: string = 'Count', dimensions?: Record<string, string>): void {
  const metricEntry = {
    level: 'METRIC',
    metricName,
    value,
    unit,
    dimensions,
    timestamp: new Date().toISOString(),
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
  };
  
  console.log(JSON.stringify(metricEntry));
}

/**
 * Log processing performance metrics
 */
export function logPerformanceMetric(operation: string, startTime: number, additionalData?: any): void {
  const processingTime = (Date.now() - startTime) / 1000;
  
  logMetric(`${operation}ProcessingTime`, processingTime, 'Seconds');
  
  logInfo(`${operation} performance`, {
    processingTimeSeconds: processingTime,
    ...additionalData,
  });
}

/**
 * Create X-Ray subsegment for operation tracing
 */
export function createXRaySubsegment(name: string, operation: () => Promise<any>): Promise<any> {
  if (AWSXRay && AWSXRay.getSegment()) {
    const subsegment = AWSXRay.getSegment().addNewSubsegment(name);
    
    return new Promise((resolve, reject) => {
      operation()
        .then(result => {
          subsegment.close();
          resolve(result);
        })
        .catch(error => {
          subsegment.addError(error);
          subsegment.close();
          reject(error);
        });
    });
  } else {
    // X-Ray not available, execute operation directly
    return operation();
  }
}

/**
 * Add X-Ray annotations for better trace filtering
 */
export function addXRayAnnotations(annotations: Record<string, string | number | boolean>): void {
  if (AWSXRay && AWSXRay.getSegment()) {
    const segment = AWSXRay.getSegment();
    Object.entries(annotations).forEach(([key, value]) => {
      segment.addAnnotation(key, value);
    });
  }
}

/**
 * Add X-Ray metadata for additional context
 */
export function addXRayMetadata(namespace: string, metadata: Record<string, any>): void {
  if (AWSXRay && AWSXRay.getSegment()) {
    const segment = AWSXRay.getSegment();
    segment.addMetadata(namespace, metadata);
  }
}/**
 *
 Create processing status metadata for tracking
 */
export function createProcessingStatus(
  originalFile: string,
  status: 'success' | 'failure',
  outputLocation?: string,
  error?: string
): any {
  return {
    originalFile,
    status,
    timestamp: new Date().toISOString(),
    outputLocation,
    error,
    processingId: generateProcessingId()
  };
}

/**
 * Generate unique processing ID for tracking
 */
export function generateProcessingId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 5);
  return `${timestamp}-${random}`;
}

/**
 * Extract metadata from S3 object for preservation
 */
export function extractS3Metadata(s3Object: any): Record<string, string> {
  const metadata: Record<string, string> = {};
  
  if (s3Object.Metadata) {
    Object.keys(s3Object.Metadata).forEach(key => {
      metadata[key] = s3Object.Metadata[key];
    });
  }
  
  // Add standard S3 properties
  if (s3Object.LastModified) {
    metadata['last-modified'] = s3Object.LastModified.toISOString();
  }
  
  if (s3Object.ContentLength) {
    metadata['content-length'] = s3Object.ContentLength.toString();
  }
  
  if (s3Object.ETag) {
    metadata['etag'] = s3Object.ETag;
  }
  
  return metadata;
}

/**
 * Validate output path format and structure
 */
export function validateOutputPath(path: string): boolean {
  // Check for date-based structure: YYYY/MM/DD/filename.md
  const pathRegex = /^\d{4}\/\d{2}\/\d{2}\/[^\/]+\.md$/;
  return pathRegex.test(path);
}

/**
 * Create comprehensive processing metadata
 */
export function createProcessingMetadata(
  originalFile: string,
  originalBucket: string,
  fileType: string,
  processingTimeSeconds: number,
  inputTokens: number,
  outputTokens: number,
  wordCount: number,
  additionalMetadata?: Record<string, any>
): Record<string, string> {
  const baseMetadata: Record<string, string> = {
    'original-file': originalFile,
    'original-bucket': originalBucket,
    'file-type': fileType,
    'processing-time-seconds': processingTimeSeconds.toString(),
    'input-tokens': inputTokens.toString(),
    'output-tokens': outputTokens.toString(),
    'word-count': wordCount.toString(),
    'generated-at': new Date().toISOString(),
    'processing-id': generateProcessingId()
  };

  // Add any additional metadata
  if (additionalMetadata) {
    Object.keys(additionalMetadata).forEach(key => {
      baseMetadata[key] = String(additionalMetadata[key]);
    });
  }

  return baseMetadata;
}