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

export interface ClaudeRequest {
  anthropic_version: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  temperature: number;
  system?: string;
}

export interface ClaudeResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  id: string;
  model: string;
  role: string;
  stop_reason: string;
  stop_sequence: null;
  type: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
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
  errorType: 'FILE_READ_ERROR' | 'CLAUDE_PROCESSING_ERROR' | 'OUTPUT_WRITE_ERROR' | 'FILE_TOO_LARGE_FOR_STEP_FUNCTIONS';
  message: string;
  timestamp: string;
  originalFile?: string;
  details?: any;
}