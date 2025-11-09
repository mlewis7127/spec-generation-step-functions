/**
 * Jest setup file for S3 Specification Generator tests
 */

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  S3: jest.fn(() => ({
    getObject: jest.fn(),
    putObject: jest.fn(),
    headObject: jest.fn(),
  })),
  StepFunctions: jest.fn(() => ({
    startExecution: jest.fn(),
  })),
  SNS: jest.fn(() => ({
    publish: jest.fn(),
  })),
}));

// Mock Bedrock Runtime
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({
    send: jest.fn(),
  })),
  InvokeModelCommand: jest.fn(),
}));

// Set test environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.ENVIRONMENT = 'test';
process.env.INPUT_BUCKET_NAME = 'test-input-bucket';
process.env.OUTPUT_BUCKET_NAME = 'test-output-bucket';