/**
 * Shared constants for the S3 Specification Generator
 */

export const SUPPORTED_FILE_FORMATS = [
  'txt',
  'pdf', 
  'doc',
  'docx',
  'md',
  'rtf',
  "java",
  "rexx",
  "py",
  "js",
  "ts"
] as const;

export const LAMBDA_TIMEOUTS = {
  READ_FILE: 120, // 2 minutes
  PROCESS_WITH_LLM: 300, // 5 minutes  
  WRITE_SPECIFICATION: 60, // 1 minute
} as const;

export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  INITIAL_INTERVAL_SECONDS: 2,
  BACKOFF_RATE: 2.0,
} as const;

export const LLM_CONFIG = {
  MAX_TOKENS: 4000,
  TEMPERATURE: 0.3,
  SYSTEM_PROMPT: 'You are a technical writer who creates clear, structured specification documents.',
} as const;

export const S3_CONFIG = {
  FILE_RETENTION_DAYS: 7,
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  STEP_FUNCTIONS_PAYLOAD_LIMIT: 200 * 1024, // 200KB (with buffer for metadata)
} as const;

export const CONTENT_VALIDATION = {
  MIN_CONTENT_LENGTH: 10,
  MAX_CONTENT_LENGTH: 1024 * 1024, // 1MB of text
} as const;

export const ERROR_MESSAGES = {
  FILE_TOO_LARGE: 'File size exceeds maximum allowed size of 10MB',
  UNSUPPORTED_FORMAT: 'File format is not supported',
  S3_READ_ERROR: 'Failed to read file from S3',
  S3_WRITE_ERROR: 'Failed to write file to S3',
  LLM_API_ERROR: 'Failed to process content with LLM via Amazon Bedrock',
  INVALID_RESPONSE: 'Received invalid response from Bedrock',
} as const;