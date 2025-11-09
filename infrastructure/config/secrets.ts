import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './environment';

export interface SecretsConfig {
  claudeApiKey?: string;
  notificationEmail?: string;
  slackWebhookUrl?: string;
  databasePassword?: string;
  encryptionKey?: string;
}

export interface ParameterConfig {
  maxFileSize: number;
  fileRetentionDays: number;
  claudeModel: string;
  enableXRayTracing: boolean;
  logRetentionDays: number;
}

/**
 * Manages secrets and parameters for the S3 Spec Generator
 */
export class SecretsManager {
  private readonly scope: Construct;
  private readonly config: EnvironmentConfig;
  private readonly secretsPrefix: string;
  private readonly parametersPrefix: string;

  constructor(scope: Construct, config: EnvironmentConfig) {
    this.scope = scope;
    this.config = config;
    this.secretsPrefix = `/s3-spec-generator/${config.environment}/secrets`;
    this.parametersPrefix = `/s3-spec-generator/${config.environment}/parameters`;
  }

  /**
   * Create or retrieve secrets for the application
   */
  public createSecrets(): { [key: string]: secretsmanager.ISecret } {
    const secrets: { [key: string]: secretsmanager.ISecret } = {};

    // Claude API Key (fallback only - primary method is Bedrock)
    secrets.claudeApiKey = new secretsmanager.Secret(this.scope, 'ClaudeApiKeySecret', {
      secretName: `${this.secretsPrefix}/claude-api-key`,
      description: 'Claude API key for direct API access (fallback only - primary method is Amazon Bedrock)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: '' }),
        generateStringKey: 'apiKey',
        excludeCharacters: '"@/\\',
      },
      removalPolicy: this.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Notification Email (stored as secret for security)
    if (this.config.notificationEmail) {
      secrets.notificationEmail = new secretsmanager.Secret(this.scope, 'NotificationEmailSecret', {
        secretName: `${this.secretsPrefix}/notification-email`,
        description: 'Email address for system notifications',
        secretStringValue: cdk.SecretValue.unsafePlainText(this.config.notificationEmail),
        removalPolicy: this.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });
    }

    // Slack Webhook URL (optional)
    secrets.slackWebhook = new secretsmanager.Secret(this.scope, 'SlackWebhookSecret', {
      secretName: `${this.secretsPrefix}/slack-webhook-url`,
      description: 'Slack webhook URL for notifications',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ webhookUrl: '' }),
        generateStringKey: 'webhookUrl',
        excludeCharacters: '"',
      },
      removalPolicy: this.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Database Password (for future use if database is added)
    secrets.databasePassword = new secretsmanager.Secret(this.scope, 'DatabasePasswordSecret', {
      secretName: `${this.secretsPrefix}/database-password`,
      description: 'Database password for application database',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'specgen_user' }),
        generateStringKey: 'password',
        excludeCharacters: '"@/\\\'',
        includeSpace: false,
        passwordLength: 32,
      },
      removalPolicy: this.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Encryption Key for additional data encryption
    secrets.encryptionKey = new secretsmanager.Secret(this.scope, 'EncryptionKeySecret', {
      secretName: `${this.secretsPrefix}/encryption-key`,
      description: 'Additional encryption key for sensitive data',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ keyId: '' }),
        generateStringKey: 'key',
        excludeCharacters: '"@/\\\'',
        includeSpace: false,
        passwordLength: 64,
      },
      removalPolicy: this.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    return secrets;
  }

  /**
   * Create SSM parameters for configuration values
   */
  public createParameters(): { [key: string]: ssm.IParameter } {
    const parameters: { [key: string]: ssm.IParameter } = {};

    // Max file size parameter
    parameters.maxFileSize = new ssm.StringParameter(this.scope, 'MaxFileSizeParameter', {
      parameterName: `${this.parametersPrefix}/max-file-size`,
      stringValue: this.config.maxFileSize.toString(),
      description: 'Maximum file size allowed for processing (bytes)',
      tier: ssm.ParameterTier.STANDARD,
    });

    // File retention days parameter
    parameters.fileRetentionDays = new ssm.StringParameter(this.scope, 'FileRetentionDaysParameter', {
      parameterName: `${this.parametersPrefix}/file-retention-days`,
      stringValue: this.config.fileRetentionDays.toString(),
      description: 'Number of days to retain files in input bucket',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Claude model parameter
    parameters.claudeModel = new ssm.StringParameter(this.scope, 'ClaudeModelParameter', {
      parameterName: `${this.parametersPrefix}/claude-model`,
      stringValue: this.config.claudeModel,
      description: 'Claude model identifier for Bedrock API',
      tier: ssm.ParameterTier.STANDARD,
    });

    // X-Ray tracing parameter
    parameters.enableXRayTracing = new ssm.StringParameter(this.scope, 'EnableXRayTracingParameter', {
      parameterName: `${this.parametersPrefix}/enable-xray-tracing`,
      stringValue: this.config.monitoring.enableXRayTracing.toString(),
      description: 'Enable X-Ray tracing for Lambda functions',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Log retention days parameter
    parameters.logRetentionDays = new ssm.StringParameter(this.scope, 'LogRetentionDaysParameter', {
      parameterName: `${this.parametersPrefix}/log-retention-days`,
      stringValue: this.config.monitoring.logRetentionDays.toString(),
      description: 'CloudWatch log retention period in days',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Lambda timeout parameter
    parameters.lambdaTimeout = new ssm.StringParameter(this.scope, 'LambdaTimeoutParameter', {
      parameterName: `${this.parametersPrefix}/lambda-timeout`,
      stringValue: this.config.lambdaTimeout.toString(),
      description: 'Lambda function timeout in seconds',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Lambda memory sizes (as JSON)
    parameters.lambdaMemorySizes = new ssm.StringParameter(this.scope, 'LambdaMemorySizesParameter', {
      parameterName: `${this.parametersPrefix}/lambda-memory-sizes`,
      stringValue: JSON.stringify(this.config.lambdaMemorySize),
      description: 'Lambda function memory sizes configuration',
      tier: ssm.ParameterTier.STANDARD,
    });

    // Environment-specific feature flags
    parameters.featureFlags = new ssm.StringParameter(this.scope, 'FeatureFlagsParameter', {
      parameterName: `${this.parametersPrefix}/feature-flags`,
      stringValue: JSON.stringify({
        enableDetailedMonitoring: this.config.monitoring.enableDetailedMonitoring,
        enableTerminationProtection: this.config.deployment.enableTerminationProtection,
        requireApproval: this.config.deployment.requireApproval,
      }),
      description: 'Feature flags for environment-specific behavior',
      tier: ssm.ParameterTier.STANDARD,
    });

    return parameters;
  }

  /**
   * Get environment variables for Lambda functions that reference secrets and parameters
   */
  public getLambdaEnvironmentVariables(secrets: { [key: string]: secretsmanager.ISecret }): Record<string, string> {
    return {
      // Basic configuration
      ENVIRONMENT: this.config.environment,
      
      // S3 bucket names
      INPUT_BUCKET_NAME: this.config.inputBucketName,
      OUTPUT_BUCKET_NAME: this.config.outputBucketName,
      
      // SNS topic
      NOTIFICATION_TOPIC_ARN: `arn:aws:sns:${cdk.Stack.of(this.scope).region}:${cdk.Stack.of(this.scope).account}:${this.config.notificationTopicName}`,
      
      // SSM parameter references (will be resolved at runtime)
      MAX_FILE_SIZE_PARAM: `${this.parametersPrefix}/max-file-size`,
      FILE_RETENTION_DAYS_PARAM: `${this.parametersPrefix}/file-retention-days`,
      CLAUDE_MODEL_PARAM: `${this.parametersPrefix}/claude-model`,
      LAMBDA_TIMEOUT_PARAM: `${this.parametersPrefix}/lambda-timeout`,
      
      // Secrets references (will be resolved at runtime)
      CLAUDE_API_KEY_SECRET: secrets.claudeApiKey?.secretArn || '',
      NOTIFICATION_EMAIL_SECRET: secrets.notificationEmail?.secretArn || '',
      SLACK_WEBHOOK_SECRET: secrets.slackWebhook?.secretArn || '',
      ENCRYPTION_KEY_SECRET: secrets.encryptionKey?.secretArn || '',
      
      // X-Ray configuration
      AWS_XRAY_TRACING_NAME: `S3SpecGenerator-${this.config.environment}`,
      AWS_XRAY_CONTEXT_MISSING: 'LOG_ERROR',
      AWS_XRAY_DEBUG_MODE: this.config.environment === 'dev' ? 'true' : 'false',
      
      // Application-specific settings
      LOG_LEVEL: this.config.environment === 'prod' ? 'INFO' : 'DEBUG',
      ENABLE_DETAILED_LOGGING: this.config.monitoring.enableDetailedMonitoring.toString(),
    };
  }

  /**
   * Create IAM policies for accessing secrets and parameters
   */
  public createAccessPolicies(secrets: { [key: string]: secretsmanager.ISecret }): {
    secretsPolicy: cdk.aws_iam.PolicyStatement;
    parametersPolicy: cdk.aws_iam.PolicyStatement;
  } {
    // Policy for accessing secrets
    const secretsPolicy = new cdk.aws_iam.PolicyStatement({
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: Object.values(secrets).map(secret => secret.secretArn),
    });

    // Policy for accessing SSM parameters
    const parametersPolicy = new cdk.aws_iam.PolicyStatement({
      effect: cdk.aws_iam.Effect.ALLOW,
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [
        `arn:aws:ssm:${cdk.Stack.of(this.scope).region}:${cdk.Stack.of(this.scope).account}:parameter${this.parametersPrefix}/*`,
      ],
    });

    return { secretsPolicy, parametersPolicy };
  }
}

/**
 * Utility functions for runtime secret and parameter access
 */
export class RuntimeConfigManager {
  /**
   * Get a secret value at runtime (for use in Lambda functions)
   */
  static async getSecret(secretArn: string, region: string): Promise<string> {
    const AWS = require('aws-sdk');
    const secretsManager = new AWS.SecretsManager({ region });
    
    try {
      const result = await secretsManager.getSecretValue({ SecretId: secretArn }).promise();
      return result.SecretString;
    } catch (error) {
      console.error(`Failed to retrieve secret ${secretArn}:`, error);
      throw error;
    }
  }

  /**
   * Get an SSM parameter value at runtime (for use in Lambda functions)
   */
  static async getParameter(parameterName: string, region: string): Promise<string> {
    const AWS = require('aws-sdk');
    const ssm = new AWS.SSM({ region });
    
    try {
      const result = await ssm.getParameter({ Name: parameterName }).promise();
      return result.Parameter.Value;
    } catch (error) {
      console.error(`Failed to retrieve parameter ${parameterName}:`, error);
      throw error;
    }
  }

  /**
   * Get multiple SSM parameters at runtime
   */
  static async getParameters(parameterNames: string[], region: string): Promise<Record<string, string>> {
    const AWS = require('aws-sdk');
    const ssm = new AWS.SSM({ region });
    
    try {
      const result = await ssm.getParameters({ Names: parameterNames }).promise();
      const parameters: Record<string, string> = {};
      
      result.Parameters.forEach((param: any) => {
        parameters[param.Name] = param.Value;
      });
      
      return parameters;
    } catch (error) {
      console.error(`Failed to retrieve parameters ${parameterNames.join(', ')}:`, error);
      throw error;
    }
  }
}