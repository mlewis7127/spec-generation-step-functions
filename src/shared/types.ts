/**
 * Shared type definitions for the S3 Specification Generator
 */

export interface FileProcessingEvent {
  bucket: string;
  key: string;
  size: number;
  timestamp: string;
  etag: string;
  content: string;
  fileType: string;
}

// Bedrock Converse API types (model-agnostic)
export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: Array<{
    text: string;
  }>;
}

export interface ConverseResponse {
  output: {
    message: {
      role: string;
      content: Array<{
        text: string;
      }>;
    };
  };
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  metrics?: {
    latencyMs: number;
  };
}

export interface SpecificationOutput {
  originalFile: string;
  generatedAt: string;
  outputLocation: string;
  processingTimeSeconds: number;
  wordCount: number;
  processingId?: string;
  fileType?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProcessingError {
  errorType: 'FILE_READ_ERROR' | 'LLM_PROCESSING_ERROR' | 'OUTPUT_WRITE_ERROR' | 'FILE_TOO_LARGE_FOR_STEP_FUNCTIONS';
  message: string;
  timestamp: string;
  originalFile?: string;
  details?: any;
}