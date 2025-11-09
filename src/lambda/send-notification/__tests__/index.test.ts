import { handler } from '../index';
import { Context } from 'aws-lambda';
import { SpecificationOutput, ProcessingError } from '../../../shared/types';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  SNS: jest.fn().mockImplementation(() => ({
    publish: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ MessageId: 'test-message-id' })
    })
  })),
  S3: jest.fn().mockImplementation(() => ({
    getSignedUrlPromise: jest.fn().mockResolvedValue('https://example.com/presigned-url')
  }))
}));

// Mock environment variables
process.env.NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-topic';
process.env.OUTPUT_BUCKET_NAME = 'test-output-bucket';
process.env.ENVIRONMENT = 'test';

describe('SendNotificationFunction', () => {
  const mockContext: Context = {
    awsRequestId: 'test-request-id',
    functionName: 'test-function',
    functionVersion: '1',
    invokedFunctionArn: 'test-arn',
    memoryLimitInMB: '128',
    getRemainingTimeInMillis: () => 30000,
    callbackWaitsForEmptyEventLoop: false,
    logGroupName: 'test-log-group',
    logStreamName: 'test-log-stream',
    succeed: jest.fn(),
    fail: jest.fn(),
    done: jest.fn(),
  };

  it('should send success notification with pre-signed URL', async () => {
    const successEvent = {
      type: 'success' as const,
      data: {
        originalFile: 'test-document.pdf',
        generatedAt: '2023-10-01T12:00:00Z',
        outputLocation: '2023/10/01/test-document-20231001120000.md',
        processingTimeSeconds: 45.2,
        wordCount: 1250,
        fileType: 'pdf',
        inputTokens: 500,
        outputTokens: 800,
        processingId: 'proc-123'
      } as SpecificationOutput,
      executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test-state-machine:test-execution'
    };

    const result = await handler(successEvent, mockContext);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('test-message-id');
  });

  it('should handle S3 URI format in outputLocation', async () => {
    const successEvent = {
      type: 'success' as const,
      data: {
        originalFile: 'test-document.pdf',
        generatedAt: '2023-10-01T12:00:00Z',
        outputLocation: 's3://test-output-bucket/2023/10/01/test-document-20231001120000.md',
        processingTimeSeconds: 45.2,
        wordCount: 1250,
        fileType: 'pdf',
        inputTokens: 500,
        outputTokens: 800,
        processingId: 'proc-123'
      } as SpecificationOutput,
      executionArn: 'arn:aws:states:us-east-1:123456789012:execution:test-state-machine:test-execution'
    };

    const result = await handler(successEvent, mockContext);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('test-message-id');
  });

  it('should send failure notification', async () => {
    const failureEvent = {
      type: 'failure' as const,
      data: {
        errorType: 'CLAUDE_PROCESSING_ERROR' as const,
        message: 'Failed to process with Claude',
        timestamp: '2023-10-01T12:00:00Z',
        originalFile: 'test-document.pdf'
      } as ProcessingError
    };

    const result = await handler(failureEvent, mockContext);

    expect(result.status).toBe('sent');
    expect(result.messageId).toBe('test-message-id');
  });

  it('should handle missing environment variables', async () => {
    delete process.env.NOTIFICATION_TOPIC_ARN;

    const successEvent = {
      type: 'success' as const,
      data: {
        originalFile: 'test-document.pdf',
        generatedAt: '2023-10-01T12:00:00Z',
        outputLocation: '2023/10/01/test-document-20231001120000.md',
        processingTimeSeconds: 45.2,
        wordCount: 1250
      } as SpecificationOutput
    };

    await expect(handler(successEvent, mockContext)).rejects.toThrow('NOTIFICATION_TOPIC_ARN environment variable not set');

    // Restore environment variable
    process.env.NOTIFICATION_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-topic';
  });
});