import { Context } from 'aws-lambda';
import { SNS, S3 } from 'aws-sdk';
import { SpecificationOutput, ProcessingError } from '../../shared/types';
import { 
  logInfo, 
  logError,
  logMetric
} from '../../shared/utils';

const sns = new SNS();
const s3 = new S3();

interface NotificationEvent {
  type: 'success' | 'failure';
  data: SpecificationOutput | ProcessingError;
  executionArn?: string;
  executionName?: string;
}

/**
 * Lambda function to send detailed notifications via SNS
 * Handles both success and failure notifications with rich content
 */
export const handler = async (
  event: NotificationEvent,
  context: Context
): Promise<{ messageId: string; status: string }> => {
  logInfo('SendNotificationFunction started', { 
    requestId: context.awsRequestId,
    notificationType: event.type 
  });
  logMetric('NotificationsSent', 1);

  try {
    const topicArn = process.env.NOTIFICATION_TOPIC_ARN;
    if (!topicArn) {
      throw new Error('NOTIFICATION_TOPIC_ARN environment variable not set');
    }

    let subject: string;
    let message: string;

    if (event.type === 'success') {
      const successData = event.data as SpecificationOutput;
      subject = `✅ S3 Spec Generator - Processing Complete`;
      message = await createSuccessMessage(successData, event.executionArn);
      logMetric('SuccessNotifications', 1);
    } else {
      const errorData = event.data as ProcessingError;
      subject = `❌ S3 Spec Generator - Processing Failed`;
      message = createFailureMessage(errorData, event.executionArn);
      logMetric('FailureNotifications', 1);
    }

    // Send notification
    const result = await sns.publish({
      TopicArn: topicArn,
      Subject: subject,
      Message: message,
      MessageAttributes: {
        NotificationType: {
          DataType: 'String',
          StringValue: event.type,
        },
        OriginalFile: {
          DataType: 'String',
          StringValue: getOriginalFileName(event.data),
        },
        Environment: {
          DataType: 'String',
          StringValue: process.env.ENVIRONMENT || 'unknown',
        },
      },
    }).promise();

    logInfo('Notification sent successfully', {
      messageId: result.MessageId,
      notificationType: event.type,
      originalFile: getOriginalFileName(event.data),
    });

    return {
      messageId: result.MessageId || 'unknown',
      status: 'sent',
    };

  } catch (error) {
    logMetric('NotificationErrors', 1);
    logError('Failed to send notification', {
      error: error instanceof Error ? error.message : String(error),
      notificationType: event.type,
      originalFile: getOriginalFileName(event.data),
    });

    // Re-throw to allow Step Functions to handle the error
    throw error;
  }
};

/**
 * Create success notification message with detailed information and pre-signed URL
 */
async function createSuccessMessage(data: SpecificationOutput, executionArn?: string): Promise<string> {
  const executionId = executionArn ? extractExecutionId(executionArn) : 'unknown';
  
  // Generate pre-signed URL for easy download
  let downloadUrl = 'Not available';
  try {
    const outputBucketName = process.env.OUTPUT_BUCKET_NAME;
    if (outputBucketName && data.outputLocation) {
      const presignedUrl = await generatePresignedUrl(outputBucketName, data.outputLocation);
      downloadUrl = presignedUrl;
      logInfo('Pre-signed URL generated successfully', { 
        outputLocation: data.outputLocation,
        urlExpiration: '24 hours'
      });
    }
  } catch (error) {
    logError('Failed to generate pre-signed URL', {
      error: error instanceof Error ? error.message : String(error),
      outputLocation: data.outputLocation
    });
    downloadUrl = `Failed to generate download link. Please access via AWS Console: ${data.outputLocation}`;
  }
  
  return `
🎉 Specification Generation Completed Successfully!

📄 Original File: ${data.originalFile}
📝 Generated Specification: ${data.outputLocation}
⏱️  Processing Time: ${data.processingTimeSeconds} seconds
📊 Word Count: ${data.wordCount || 'N/A'}
🔤 File Type: ${data.fileType || 'N/A'}

💰 Token Usage:
   • Input Tokens: ${data.inputTokens || 'N/A'}
   • Output Tokens: ${data.outputTokens || 'N/A'}

🔍 Processing Details:
   • Generated At: ${data.generatedAt}
   • Processing ID: ${data.processingId || 'N/A'}
   • Execution ID: ${executionId}

📥 DOWNLOAD YOUR SPECIFICATION:
${downloadUrl}

⚠️  Note: This download link expires in 24 hours for security purposes.

📍 S3 Location: ${data.outputLocation}

The specification document has been successfully generated and is ready for download!
`.trim();
}

/**
 * Create failure notification message with error details
 */
function createFailureMessage(data: ProcessingError, executionArn?: string): string {
  const executionId = executionArn ? extractExecutionId(executionArn) : 'unknown';
  
  return `
⚠️ Specification Generation Failed

📄 Original File: ${data.originalFile || 'Unknown'}
❌ Error Type: ${data.errorType}
📝 Error Message: ${data.message}
⏰ Failed At: ${data.timestamp}

🔍 Processing Details:
   • Execution ID: ${executionId}
   • Error Details: ${data.details ? JSON.stringify(data.details, null, 2) : 'No additional details'}

🛠️ Troubleshooting:
   • Check CloudWatch logs for detailed error information
   • Verify file format is supported (txt, pdf, doc, docx, md, rtf)
   • Ensure file size is under 10MB
   • Check AWS service quotas and permissions

📊 Monitoring:
   • View detailed metrics in CloudWatch Dashboard
   • Check Step Functions execution history
   • Review Lambda function logs for specific error details

If this issue persists, please contact the system administrator.
`.trim();
}

/**
 * Extract original file name from processing data
 */
function getOriginalFileName(data: SpecificationOutput | ProcessingError): string {
  return data.originalFile || 'unknown';
}

/**
 * Extract execution ID from Step Functions execution ARN
 */
function extractExecutionId(executionArn: string): string {
  const parts = executionArn.split(':');
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Generate a pre-signed URL for downloading the specification file
 */
async function generatePresignedUrl(bucketName: string, keyOrUri: string): Promise<string> {
  // Extract the key from S3 URI if provided in s3://bucket/key format
  const key = extractS3KeyFromUri(keyOrUri, bucketName);
  
  const params = {
    Bucket: bucketName,
    Key: key,
    Expires: 24 * 60 * 60, // 24 hours in seconds
    ResponseContentDisposition: `attachment; filename="${extractFilenameFromKey(key)}"`,
    ResponseContentType: 'text/markdown',
  };

  try {
    const url = await s3.getSignedUrlPromise('getObject', params);
    logInfo('Pre-signed URL generated', {
      bucketName,
      originalInput: keyOrUri,
      extractedKey: key,
      urlGenerated: true
    });
    return url;
  } catch (error) {
    logError('Failed to generate pre-signed URL', {
      bucketName,
      originalInput: keyOrUri,
      extractedKey: key,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Extract S3 key from URI or return as-is if already a key
 */
function extractS3KeyFromUri(keyOrUri: string, expectedBucket: string): string {
  // Check if it's an S3 URI (s3://bucket/key format)
  if (keyOrUri.startsWith('s3://')) {
    const uriParts = keyOrUri.replace('s3://', '').split('/');
    const bucket = uriParts[0];
    const key = uriParts.slice(1).join('/');
    
    // Validate that the bucket matches what we expect
    if (bucket !== expectedBucket) {
      logError('S3 URI bucket mismatch', {
        expectedBucket,
        actualBucket: bucket,
        fullUri: keyOrUri
      });
      throw new Error(`S3 URI bucket mismatch: expected ${expectedBucket}, got ${bucket}`);
    }
    
    return key;
  }
  
  // If it doesn't start with s3://, assume it's already a key
  return keyOrUri;
}

/**
 * Extract filename from S3 key path
 */
function extractFilenameFromKey(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || 'specification.md';
}