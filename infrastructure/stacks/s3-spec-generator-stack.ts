import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';
import { EnvironmentConfig, generateResourceName, validateConfig } from '../config/environment';

export interface S3SpecGeneratorStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class S3SpecGeneratorStack extends cdk.Stack {
  public readonly inputBucket: s3.Bucket;
  public readonly outputBucket: s3.Bucket;
  public readonly stateMachine: stepfunctions.StateMachine;
  public readonly notificationTopic: sns.Topic;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly logGroups: { [key: string]: logs.LogGroup };
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly lambdaFunctions: { [key: string]: lambda.Function } = {};

  constructor(scope: Construct, id: string, props: S3SpecGeneratorStackProps) {
    super(scope, id, props);

    // Validate configuration before deployment
    const configValidation = validateConfig(props.config);
    if (!configValidation.isValid) {
      throw new Error(`Configuration validation failed: ${configValidation.errors.join(', ')}`);
    }

    // Apply stack-level configuration
    if (props.config.deployment.enableTerminationProtection) {
      this.terminationProtection = true;
    }

    // Create S3 input bucket with enhanced security and encryption
    this.inputBucket = new s3.Bucket(this, 'InputBucket', {
      bucketName: props.config.inputBucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      enforceSSL: true, // Require SSL/TLS for all requests
      lifecycleRules: [
        {
          id: 'DeleteProcessedFiles',
          enabled: true,
          expiration: cdk.Duration.days(props.config.fileRetentionDays),
        },
        {
          id: 'AbortIncompleteMultipartUploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: props.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      accessControl: s3.BucketAccessControl.PRIVATE,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });

    // Create S3 output bucket with enhanced security and encryption
    this.outputBucket = new s3.Bucket(this, 'OutputBucket', {
      bucketName: props.config.outputBucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true, // Require SSL/TLS for all requests
      lifecycleRules: [
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
        {
          id: 'AbortIncompleteMultipartUploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: props.config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      accessControl: s3.BucketAccessControl.PRIVATE,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });

    // Create SNS topic for notifications
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: props.config.notificationTopicName,
      displayName: 'S3 Spec Generator Notifications',
    });

    // Configure SNS subscriptions
    this.configureSNSSubscriptions(props.config);

    // Create dead letter queue for failed Step Functions executions
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `spec-generator-dlq-${props.config.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(5),
    });

    // Create CloudWatch log groups for Lambda functions (needed for security metric filters)
    this.logGroups = this.createLogGroups(props.config);

    // Configure enhanced security policies for both buckets (requires log groups)
    this.configureS3BucketSecurity(props.config);

    // Create Lambda functions
    this.createLambdaFunctions(props.config);

    // Create Step Functions state machine
    this.stateMachine = this.createStateMachine(props.config);

    // Configure S3 event notifications to trigger Step Functions
    this.configureS3EventNotifications(this.stateMachine, props.config);

    // Configure X-Ray tracing
    this.configureXRayTracing(props.config);

    // Create CloudWatch dashboard and alarms
    this.dashboard = this.createMonitoringDashboard(props.config);
    this.createCloudWatchAlarms(props.config);

    // Apply tags for resource management
    Object.entries(props.config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });
  }

  /**
   * Configure enhanced security policies for S3 buckets
   */
  private configureS3BucketSecurity(config: EnvironmentConfig): void {
    // Input bucket security policy - restrict access to specific principals and require encryption
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureConnections',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [
        this.inputBucket.bucketArn,
        `${this.inputBucket.bucketArn}/*`,
      ],
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
    }));

    // Deny unencrypted object uploads to input bucket
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyUnencryptedObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [`${this.inputBucket.bucketArn}/*`],
      conditions: {
        StringNotEquals: {
          's3:x-amz-server-side-encryption': 'AES256',
        },
      },
    }));

    // Allow AWS services access to input bucket
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAWSServicesAccess',
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('events.amazonaws.com'),
      ],
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:ListBucket',
        's3:GetBucketLocation',
        's3:PutObject', // For EventBridge notifications
      ],
      resources: [
        this.inputBucket.bucketArn,
        `${this.inputBucket.bucketArn}/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Allow authenticated users from the same account to access bucket metadata
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAuthenticatedUserBucketAccess',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [this.inputBucket.bucketArn],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Allow authenticated users from the same account to upload objects with encryption
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAuthenticatedUserPutObject',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['s3:PutObject'],
      resources: [`${this.inputBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
          's3:x-amz-server-side-encryption': 'AES256', // Require encryption for uploads
        },
      },
    }));

    // Allow authenticated users from the same account to set object ACLs
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAuthenticatedUserPutObjectAcl',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: ['s3:PutObjectAcl'],
      resources: [`${this.inputBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Allow authenticated users from the same account to read objects (no encryption condition needed)
    this.inputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAuthenticatedUserDownloads',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        's3:GetObject',
      ],
      resources: [`${this.inputBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Output bucket security policy - restrict access and require encryption
    this.outputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureConnections',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [
        this.outputBucket.bucketArn,
        `${this.outputBucket.bucketArn}/*`,
      ],
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
    }));

    // Deny unencrypted object uploads to output bucket
    this.outputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyUnencryptedObjectUploads',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [`${this.outputBucket.bucketArn}/*`],
      conditions: {
        StringNotEquals: {
          's3:x-amz-server-side-encryption': 'AES256',
        },
      },
    }));

    // Allow Lambda functions to write to output bucket
    this.outputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowLambdaFunctionsWrite',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:PutObjectTagging',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        this.outputBucket.bucketArn,
        `${this.outputBucket.bucketArn}/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Allow authenticated users to download generated specifications
    this.outputBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAuthenticatedUserDownloads',
      effect: iam.Effect.ALLOW,
      principals: [new iam.AccountRootPrincipal()],
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [
        this.outputBucket.bucketArn,
        `${this.outputBucket.bucketArn}/*`,
      ],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Configure CORS for input bucket (restrictive - only allow specific origins if needed)
    if (config.environment !== 'prod') {
      // Only enable CORS for non-production environments
      this.inputBucket.addCorsRule({
        allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT],
        allowedOrigins: ['https://localhost:3000', `https://${config.environment}.spec-generator.internal`],
        allowedHeaders: ['Content-Type', 'Content-Length', 'Authorization'],
        exposedHeaders: ['ETag'],
        maxAge: 300, // 5 minutes
      });
    }

    // Configure access logging for both buckets (security requirement)
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `spec-generator-access-logs-${config.environment}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeleteAccessLogs',
          enabled: true,
          expiration: cdk.Duration.days(90), // Keep access logs for 90 days
        },
      ],
      removalPolicy: config.environment === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Grant S3 logging service permission to write to access logs bucket
    accessLogsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowS3LogDelivery',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [`${accessLogsBucket.bucketArn}/*`],
      conditions: {
        ArnEquals: {
          'aws:SourceArn': [this.inputBucket.bucketArn, this.outputBucket.bucketArn],
        },
      },
    }));

    accessLogsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowS3LogDeliveryAclCheck',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [accessLogsBucket.bucketArn],
      conditions: {
        ArnEquals: {
          'aws:SourceArn': [this.inputBucket.bucketArn, this.outputBucket.bucketArn],
        },
      },
    }));

    // Configure server access logging using CDK properties
    // Note: Server access logging configuration is set at bucket creation time
    // For existing buckets, this would need to be done via CloudFormation custom resource

    // Create CloudWatch metric filters for security monitoring
    this.createSecurityMetricFilters(config);

    // Configure additional security monitoring
    this.configureSecurityMonitoring(config);
  }

  /**
   * Configure additional security monitoring and compliance
   */
  private configureSecurityMonitoring(config: EnvironmentConfig): void {
    // Create CloudTrail for API call monitoring (if not already exists)
    // Note: CloudTrail should be configured at the account level, but we can create
    // specific event rules for our resources

    // Create EventBridge rule to monitor S3 bucket policy changes
    const bucketPolicyChangeRule = new events.Rule(this, 'BucketPolicyChangeRule', {
      ruleName: `s3-spec-generator-policy-changes-${config.environment}`,
      description: 'Monitor S3 bucket policy changes for security compliance',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['s3.amazonaws.com'],
          eventName: [
            'PutBucketPolicy',
            'DeleteBucketPolicy',
            'PutBucketAcl',
            'PutBucketPublicAccessBlock',
          ],
          requestParameters: {
            bucketName: [this.inputBucket.bucketName, this.outputBucket.bucketName],
          },
        },
      },
    });

    // Send bucket policy change notifications to SNS
    bucketPolicyChangeRule.addTarget(new targets.SnsTopic(this.notificationTopic, {
      message: events.RuleTargetInput.fromText(
        'Security Alert: S3 bucket policy change detected for spec generator buckets'
      ),
    }));

    // Create EventBridge rule to monitor IAM role changes
    const iamRoleChangeRule = new events.Rule(this, 'IAMRoleChangeRule', {
      ruleName: `s3-spec-generator-iam-changes-${config.environment}`,
      description: 'Monitor IAM role changes for Lambda functions',
      eventPattern: {
        source: ['aws.iam'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['iam.amazonaws.com'],
          eventName: [
            'AttachRolePolicy',
            'DetachRolePolicy',
            'PutRolePolicy',
            'DeleteRolePolicy',
          ],
          requestParameters: {
            roleName: [
              `ReadFileFunction-Role-${config.environment}`,
              `ProcessWithClaudeFunction-Role-${config.environment}`,
              `WriteSpecificationFunction-Role-${config.environment}`,
              `SendNotificationFunction-Role-${config.environment}`,
              `StateMachine-Role-${config.environment}`,
            ],
          },
        },
      },
    });

    // Send IAM role change notifications to SNS
    iamRoleChangeRule.addTarget(new targets.SnsTopic(this.notificationTopic, {
      message: events.RuleTargetInput.fromText(
        'Security Alert: IAM role change detected for spec generator Lambda functions'
      ),
    }));

    // Create Config rules for compliance monitoring (if AWS Config is enabled)
    this.createComplianceRules(config);
  }

  /**
   * Create AWS Config rules for compliance monitoring
   */
  private createComplianceRules(config: EnvironmentConfig): void {
    // Note: These Config rules require AWS Config to be enabled in the account
    // They are created as CloudFormation resources since CDK doesn't have full Config support
    // Only create Config rules for production and staging environments
    if (config.environment === 'dev') {
      return; // Skip Config rules for development environment
    }

    // S3 bucket encryption compliance rule for input bucket
    new cdk.CfnResource(this, 'InputBucketEncryptionComplianceRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `input-bucket-encryption-enabled-${config.environment}`,
        Description: 'Checks that input S3 bucket has server-side encryption enabled',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.inputBucket.bucketName,
        },
      },
    });

    // S3 bucket encryption compliance rule for output bucket
    new cdk.CfnResource(this, 'OutputBucketEncryptionComplianceRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `output-bucket-encryption-enabled-${config.environment}`,
        Description: 'Checks that output S3 bucket has server-side encryption enabled',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.outputBucket.bucketName,
        },
      },
    });

    // S3 bucket public read access compliance rule for input bucket
    new cdk.CfnResource(this, 'InputBucketPublicReadRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `input-bucket-public-read-prohibited-${config.environment}`,
        Description: 'Checks that input S3 bucket does not allow public read access',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.inputBucket.bucketName,
        },
      },
    });

    // S3 bucket public write access compliance rule for input bucket
    new cdk.CfnResource(this, 'InputBucketPublicWriteRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `input-bucket-public-write-prohibited-${config.environment}`,
        Description: 'Checks that input S3 bucket does not allow public write access',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_PUBLIC_WRITE_PROHIBITED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.inputBucket.bucketName,
        },
      },
    });

    // S3 bucket public read access compliance rule for output bucket
    new cdk.CfnResource(this, 'OutputBucketPublicReadRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `output-bucket-public-read-prohibited-${config.environment}`,
        Description: 'Checks that output S3 bucket does not allow public read access',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_PUBLIC_READ_PROHIBITED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.outputBucket.bucketName,
        },
      },
    });

    // S3 bucket public write access compliance rule for output bucket
    new cdk.CfnResource(this, 'OutputBucketPublicWriteRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `output-bucket-public-write-prohibited-${config.environment}`,
        Description: 'Checks that output S3 bucket does not allow public write access',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'S3_BUCKET_PUBLIC_WRITE_PROHIBITED',
        },
        Scope: {
          ComplianceResourceTypes: ['AWS::S3::Bucket'],
          ComplianceResourceId: this.outputBucket.bucketName,
        },
      },
    });

    // Lambda function encryption compliance rule
    new cdk.CfnResource(this, 'LambdaFunctionEncryptionRule', {
      type: 'AWS::Config::ConfigRule',
      properties: {
        ConfigRuleName: `lambda-function-settings-check-${config.environment}`,
        Description: 'Checks Lambda function configuration for security best practices',
        Source: {
          Owner: 'AWS',
          SourceIdentifier: 'LAMBDA_FUNCTION_SETTINGS_CHECK',
        },
        InputParameters: JSON.stringify({
          runtime: 'python3.11',
          timeout: '300',
        }),
      },
    });
  }

  /**
   * Create KMS encryption keys for enhanced security (optional upgrade from S3-managed encryption)
   */
  private createKMSEncryptionKeys(config: EnvironmentConfig): {
    s3Key: any; // KMS key for S3 encryption
    lambdaKey: any; // KMS key for Lambda environment variables
  } {
    // Import KMS module if using customer-managed keys
    // This is commented out as we're using S3-managed encryption per requirements
    // Uncomment and modify if customer-managed keys are needed in the future
    
    /*
    import * as kms from 'aws-cdk-lib/aws-kms';
    
    const s3Key = new kms.Key(this, 'S3EncryptionKey', {
      description: `KMS key for S3 bucket encryption - ${config.environment}`,
      enableKeyRotation: true,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'EnableRootAccess',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: ['kms:*'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'AllowS3Service',
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
            actions: [
              'kms:Decrypt',
              'kms:GenerateDataKey',
            ],
            resources: ['*'],
            conditions: {
              StringEquals: {
                'kms:ViaService': `s3.${this.region}.amazonaws.com`,
              },
            },
          }),
        ],
      }),
    });

    const lambdaKey = new kms.Key(this, 'LambdaEncryptionKey', {
      description: `KMS key for Lambda environment variables - ${config.environment}`,
      enableKeyRotation: true,
      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    });

    return { s3Key, lambdaKey };
    */
    
    // Return null for now since we're using S3-managed encryption
    return { s3Key: null, lambdaKey: null };
  }

  /**
   * Create security-focused CloudWatch metric filters
   */
  private createSecurityMetricFilters(config: EnvironmentConfig): void {
    const securityNamespace = `S3SpecGenerator/Security/${config.environment}`;

    // Monitor failed authentication attempts
    new logs.MetricFilter(this, 'FailedAuthMetricFilter', {
      logGroup: this.logGroups.readFile,
      metricNamespace: securityNamespace,
      metricName: 'FailedAuthentication',
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
        logs.FilterPattern.stringValue('$.message', '=', 'Access denied')
      ),
      metricValue: '1',
      defaultValue: 0,
    });

    // Monitor suspicious file access patterns
    new logs.MetricFilter(this, 'SuspiciousAccessMetricFilter', {
      logGroup: this.logGroups.readFile,
      metricNamespace: securityNamespace,
      metricName: 'SuspiciousFileAccess',
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Suspicious file access detected'),
      metricValue: '1',
      defaultValue: 0,
    });

    // Monitor large file uploads (potential security risk)
    new logs.MetricFilter(this, 'LargeFileUploadMetricFilter', {
      logGroup: this.logGroups.readFile,
      metricNamespace: securityNamespace,
      metricName: 'LargeFileUploads',
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.exists('$.data.fileSize'),
        logs.FilterPattern.numberValue('$.data.fileSize', '>', 5000000) // > 5MB
      ),
      metricValue: '1',
      defaultValue: 0,
    });

    // Create security alarms
    const failedAuthAlarm = new cloudwatch.Alarm(this, 'FailedAuthenticationAlarm', {
      alarmName: `${config.environment}-security-failed-auth`,
      alarmDescription: 'Alert on failed authentication attempts',
      metric: new cloudwatch.Metric({
        namespace: securityNamespace,
        metricName: 'FailedAuthentication',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5, // Alert after 5 failed attempts in 5 minutes
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const suspiciousAccessAlarm = new cloudwatch.Alarm(this, 'SuspiciousAccessAlarm', {
      alarmName: `${config.environment}-security-suspicious-access`,
      alarmDescription: 'Alert on suspicious file access patterns',
      metric: new cloudwatch.Metric({
        namespace: securityNamespace,
        metricName: 'SuspiciousFileAccess',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1, // Alert on any suspicious access
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS actions to security alarms
    [failedAuthAlarm, suspiciousAccessAlarm].forEach(alarm => {
      alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.notificationTopic));
    });
  }

  /**
   * Create CloudWatch log groups for all Lambda functions
   */
  private createLogGroups(config: EnvironmentConfig): { [key: string]: logs.LogGroup } {
    const logGroups: { [key: string]: logs.LogGroup } = {};

    // Log group for ReadFileFunction
    logGroups.readFile = new logs.LogGroup(this, 'ReadFileFunctionLogGroup', {
      logGroupName: `/aws/lambda/ReadFileFunction-${config.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for ProcessWithClaudeFunction
    logGroups.processWithClaude = new logs.LogGroup(this, 'ProcessWithClaudeFunctionLogGroup', {
      logGroupName: `/aws/lambda/ProcessWithClaudeFunction-${config.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for WriteSpecificationFunction
    logGroups.writeSpecification = new logs.LogGroup(this, 'WriteSpecificationFunctionLogGroup', {
      logGroupName: `/aws/lambda/WriteSpecificationFunction-${config.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for SendNotificationFunction
    logGroups.sendNotification = new logs.LogGroup(this, 'SendNotificationFunctionLogGroup', {
      logGroupName: `/aws/lambda/SendNotificationFunction-${config.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for Step Functions
    logGroups.stepFunctions = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/stepfunctions/${config.stepFunctionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Log group for EventBridge
    logGroups.eventBridge = new logs.LogGroup(this, 'EventBridgeLogGroup', {
      logGroupName: `/aws/events/rule/s3-spec-generator-trigger-${config.environment}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create custom metric filters for each log group
    this.createMetricFilters(logGroups, config);

    return logGroups;
  }

  /**
   * Create custom metric filters for processing times and success rates
   */
  private createMetricFilters(logGroups: { [key: string]: logs.LogGroup }, config: EnvironmentConfig): void {
    const metricNamespace = `S3SpecGenerator/${config.environment}`;

    // Processing time metrics for each Lambda function
    Object.entries(logGroups).forEach(([functionName, logGroup]) => {
      if (functionName !== 'stepFunctions' && functionName !== 'eventBridge') {
        // Processing time metric
        new logs.MetricFilter(this, `${functionName}ProcessingTimeMetric`, {
          logGroup,
          metricNamespace,
          metricName: `${functionName}ProcessingTime`,
          filterPattern: logs.FilterPattern.exists('$.data.processingTimeSeconds'),
          metricValue: '$.data.processingTimeSeconds',
          defaultValue: 0,
        });

        // Success rate metric
        new logs.MetricFilter(this, `${functionName}SuccessMetric`, {
          logGroup,
          metricNamespace,
          metricName: `${functionName}Success`,
          filterPattern: logs.FilterPattern.all(
            logs.FilterPattern.stringValue('$.level', '=', 'INFO'),
            logs.FilterPattern.stringValue('$.message', '=', `${functionName}Function completed successfully`)
          ),
          metricValue: '1',
          defaultValue: 0,
        });

        // Error rate metric
        new logs.MetricFilter(this, `${functionName}ErrorMetric`, {
          logGroup,
          metricNamespace,
          metricName: `${functionName}Errors`,
          filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
          metricValue: '1',
          defaultValue: 0,
        });
      }
    });

    // Step Functions execution metrics
    new logs.MetricFilter(this, 'StepFunctionsExecutionMetric', {
      logGroup: logGroups.stepFunctions,
      metricNamespace,
      metricName: 'StepFunctionsExecutions',
      filterPattern: logs.FilterPattern.exists('$.execution_arn'),
      metricValue: '1',
      defaultValue: 0,
    });

    // File processing volume metric
    new logs.MetricFilter(this, 'FilesProcessedMetric', {
      logGroup: logGroups.readFile,
      metricNamespace,
      metricName: 'FilesProcessed',
      filterPattern: logs.FilterPattern.stringValue('$.message', '=', 'Processing file'),
      metricValue: '1',
      defaultValue: 0,
    });

    // Token usage metrics for Claude processing
    new logs.MetricFilter(this, 'InputTokensMetric', {
      logGroup: logGroups.processWithClaude,
      metricNamespace,
      metricName: 'ClaudeInputTokens',
      filterPattern: logs.FilterPattern.exists('$.data.inputTokens'),
      metricValue: '$.data.inputTokens',
      defaultValue: 0,
    });

    new logs.MetricFilter(this, 'OutputTokensMetric', {
      logGroup: logGroups.processWithClaude,
      metricNamespace,
      metricName: 'ClaudeOutputTokens',
      filterPattern: logs.FilterPattern.exists('$.data.outputTokens'),
      metricValue: '$.data.outputTokens',
      defaultValue: 0,
    });
  }

  /**
   * Create IAM roles and policies for Lambda functions
   */
  private createLambdaIAMRoles(config: EnvironmentConfig): {
    readFileRole: iam.Role;
    processWithClaudeRole: iam.Role;
    writeSpecificationRole: iam.Role;
    sendNotificationRole: iam.Role;
  } {
    // ReadFileFunction IAM Role - least privilege for S3 read operations
    const readFileRole = new iam.Role(this, 'ReadFileFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for ReadFileFunction with least-privilege S3 read access',
      roleName: `ReadFileFunction-Role-${config.environment}`,
    });

    // Basic Lambda execution permissions
    readFileRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // S3 read permissions for input bucket only
    readFileRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
      ],
      resources: [`${this.inputBucket.bucketArn}/*`],
    }));

    // S3 bucket metadata access for input bucket
    readFileRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [this.inputBucket.bucketArn],
    }));

    // X-Ray tracing permissions
    readFileRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs permissions (specific log group)
    readFileRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/ReadFileFunction-${config.environment}:*`],
    }));

    // ProcessWithClaudeFunction IAM Role - least privilege for Bedrock access
    const processWithClaudeRole = new iam.Role(this, 'ProcessWithClaudeFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for ProcessWithClaudeFunction with least-privilege Bedrock access',
      roleName: `ProcessWithClaudeFunction-Role-${config.environment}`,
    });

    // Basic Lambda execution permissions
    processWithClaudeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Bedrock permissions for Claude model only
    processWithClaudeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
      ],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0`,
        `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`, // Fallback model
      ],
    }));

    // X-Ray tracing permissions
    processWithClaudeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs permissions (specific log group)
    processWithClaudeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/ProcessWithClaudeFunction-${config.environment}:*`],
    }));

    // WriteSpecificationFunction IAM Role - least privilege for S3 write operations
    const writeSpecificationRole = new iam.Role(this, 'WriteSpecificationFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for WriteSpecificationFunction with least-privilege S3 write access',
      roleName: `WriteSpecificationFunction-Role-${config.environment}`,
    });

    // Basic Lambda execution permissions
    writeSpecificationRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // S3 write permissions for output bucket only
    writeSpecificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
        's3:PutObjectAcl',
        's3:PutObjectTagging',
      ],
      resources: [`${this.outputBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          's3:x-amz-server-side-encryption': 'AES256',
        },
      },
    }));

    // S3 bucket metadata access for output bucket
    writeSpecificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [this.outputBucket.bucketArn],
    }));

    // X-Ray tracing permissions
    writeSpecificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs permissions (specific log group)
    writeSpecificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/WriteSpecificationFunction-${config.environment}:*`],
    }));

    // SendNotificationFunction IAM Role - least privilege for SNS operations
    const sendNotificationRole = new iam.Role(this, 'SendNotificationFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'IAM role for SendNotificationFunction with least-privilege SNS access',
      roleName: `SendNotificationFunction-Role-${config.environment}`,
    });

    // Basic Lambda execution permissions
    sendNotificationRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // SNS publish permissions for notification topic only
    sendNotificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sns:Publish',
      ],
      resources: [this.notificationTopic.topicArn],
    }));

    // S3 permissions for generating pre-signed URLs for output bucket
    sendNotificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:GetObjectVersion',
      ],
      resources: [`${this.outputBucket.bucketArn}/*`],
    }));

    // S3 bucket permissions for pre-signed URL generation
    sendNotificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:GetBucketLocation',
      ],
      resources: [this.outputBucket.bucketArn],
    }));

    // X-Ray tracing permissions
    sendNotificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));

    // CloudWatch Logs permissions (specific log group)
    sendNotificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/SendNotificationFunction-${config.environment}:*`],
    }));

    return {
      readFileRole,
      processWithClaudeRole,
      writeSpecificationRole,
      sendNotificationRole,
    };
  }

  /**
   * Get common environment variables for Lambda functions
   */
  private getLambdaEnvironmentVariables(config: EnvironmentConfig): { [key: string]: string } {
    return {
      ENVIRONMENT: config.environment,
      INPUT_BUCKET_NAME: this.inputBucket.bucketName,
      OUTPUT_BUCKET_NAME: this.outputBucket.bucketName,
      NOTIFICATION_TOPIC_ARN: this.notificationTopic.topicArn,
      CLAUDE_MODEL: config.claudeModel,
      MAX_FILE_SIZE: config.maxFileSize.toString(),
      LOG_LEVEL: config.environment === 'prod' ? 'INFO' : 'DEBUG',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };
  }

  /**
   * Create Lambda functions for the S3 Spec Generator
   */
  private createLambdaFunctions(config: EnvironmentConfig): void {
    // Create Lambda IAM roles first
    const lambdaRoles = this.createLambdaIAMRoles(config);
    
    // Get common environment variables
    const commonEnvVars = this.getLambdaEnvironmentVariables(config);

    // Initialize Lambda functions object (already initialized in property declaration)

    // ReadFile Lambda Function
    this.lambdaFunctions.readFile = new lambda.Function(this, 'ReadFileFunction', {
      functionName: `ReadFileFunction-${config.environment}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('dist/lambda/read-file'),
      role: lambdaRoles.readFileRole,
      timeout: cdk.Duration.seconds(config.lambdaTimeout),
      memorySize: config.lambdaMemorySize.readFile,
      environment: commonEnvVars,
      logGroup: this.logGroups.readFile,
      tracing: config.monitoring.enableXRayTracing ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
      description: 'Reads files from S3 input bucket for processing',
    });

    // ProcessWithClaude Lambda Function
    this.lambdaFunctions.processWithClaude = new lambda.Function(this, 'ProcessWithClaudeFunction', {
      functionName: `ProcessWithClaudeFunction-${config.environment}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('dist/lambda/process-with-claude'),
      role: lambdaRoles.processWithClaudeRole,
      timeout: cdk.Duration.seconds(config.lambdaTimeout),
      memorySize: config.lambdaMemorySize.processWithLLM,
      environment: commonEnvVars,
      logGroup: this.logGroups.processWithClaude,
      tracing: config.monitoring.enableXRayTracing ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
      description: 'Processes file content with Claude via Amazon Bedrock',
    });

    // WriteSpecification Lambda Function
    this.lambdaFunctions.writeSpecification = new lambda.Function(this, 'WriteSpecificationFunction', {
      functionName: `WriteSpecificationFunction-${config.environment}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('dist/lambda/write-specification'),
      role: lambdaRoles.writeSpecificationRole,
      timeout: cdk.Duration.seconds(config.lambdaTimeout),
      memorySize: config.lambdaMemorySize.writeSpecification,
      environment: commonEnvVars,
      logGroup: this.logGroups.writeSpecification,
      tracing: config.monitoring.enableXRayTracing ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
      description: 'Writes generated specifications to S3 output bucket',
    });

    // SendNotification Lambda Function
    this.lambdaFunctions.sendNotification = new lambda.Function(this, 'SendNotificationFunction', {
      functionName: `SendNotificationFunction-${config.environment}`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('dist/lambda/send-notification'),
      role: lambdaRoles.sendNotificationRole,
      timeout: cdk.Duration.seconds(config.lambdaTimeout),
      memorySize: config.lambdaMemorySize.sendNotification,
      environment: commonEnvVars,
      logGroup: this.logGroups.sendNotification,
      tracing: config.monitoring.enableXRayTracing ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
      description: 'Sends notifications about processing results',
    });
  }

  /**
   * Create Step Functions state machine with Lambda functions
   */
  private createStateMachine(config: EnvironmentConfig): stepfunctions.StateMachine {

    // Create IAM role for Step Functions execution
    const stateMachineRole = new iam.Role(this, 'StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'IAM role for S3 Spec Generator Step Functions state machine',
      roleName: `StateMachine-Role-${config.environment}`,
    });

    // Add permissions for Lambda function invocation (specific functions only)
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:InvokeFunction',
      ],
      resources: [
        this.lambdaFunctions.readFile.functionArn,
        this.lambdaFunctions.processWithClaude.functionArn,
        this.lambdaFunctions.writeSpecification.functionArn,
        this.lambdaFunctions.sendNotification.functionArn,
      ],
    }));

    // Add permissions for SNS notifications (specific topic only)
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sns:Publish',
      ],
      resources: [this.notificationTopic.topicArn],
    }));

    // Add X-Ray tracing permissions
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
      ],
      resources: ['*'],
    }));

    // Add CloudWatch logging permissions (specific log group only)
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/stepfunctions/${config.stepFunctionName}:*`],
    }));

    // Define retry configuration for Lambda tasks
    const retryConfig = {
      errors: ['States.ALL'],
      interval: cdk.Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2.0,
    };

    // Define the state machine tasks using CDK v2 syntax
    const readFileTask = new sfnTasks.LambdaInvoke(this, 'ReadFileTask', {
      lambdaFunction: this.lambdaFunctions.readFile,
      retryOnServiceExceptions: true,
      outputPath: '$.Payload',
    });
    readFileTask.addRetry(retryConfig);

    const processWithClaudeTask = new sfnTasks.LambdaInvoke(this, 'ProcessWithClaudeTask', {
      lambdaFunction: this.lambdaFunctions.processWithClaude,
      retryOnServiceExceptions: true,
      outputPath: '$.Payload',
    });
    processWithClaudeTask.addRetry({
      errors: ['States.ALL'],
      interval: cdk.Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2.0,
    });

    const writeSpecificationTask = new sfnTasks.LambdaInvoke(this, 'WriteSpecificationTask', {
      lambdaFunction: this.lambdaFunctions.writeSpecification,
      retryOnServiceExceptions: true,
      outputPath: '$.Payload',
    });
    writeSpecificationTask.addRetry(retryConfig);

    const notifySuccessTask = new sfnTasks.LambdaInvoke(this, 'NotifySuccessTask', {
      lambdaFunction: this.lambdaFunctions.sendNotification,
      payload: stepfunctions.TaskInput.fromObject({
        type: 'success',
        data: stepfunctions.JsonPath.objectAt('$'),
        executionArn: stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
        executionName: stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
      }),
      retryOnServiceExceptions: true,
    });

    const notifyFailureTask = new sfnTasks.LambdaInvoke(this, 'NotifyFailureTask', {
      lambdaFunction: this.lambdaFunctions.sendNotification,
      payload: stepfunctions.TaskInput.fromObject({
        type: 'failure',
        data: stepfunctions.JsonPath.objectAt('$.error'),
        executionArn: stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
        executionName: stepfunctions.JsonPath.stringAt('$$.Execution.Name'),
      }),
      retryOnServiceExceptions: true,
    });

    // Define the workflow chain
    const definition = readFileTask
      .next(processWithClaudeTask)
      .next(writeSpecificationTask)
      .next(notifySuccessTask);

    // Add error handling
    readFileTask.addCatch(notifyFailureTask, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    processWithClaudeTask.addCatch(notifyFailureTask, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    writeSpecificationTask.addCatch(notifyFailureTask, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    // Create the state machine
    const stateMachine = new stepfunctions.StateMachine(this, 'SpecGeneratorStateMachine', {
      stateMachineName: config.stepFunctionName,
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      role: stateMachineRole,
      timeout: cdk.Duration.minutes(10),
      logs: {
        destination: this.logGroups.stepFunctions,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    return stateMachine;
  }

  /**
   * Configure S3 event notifications to trigger Step Functions
   * This method should be called after the Step Functions state machine is created
   */
  private configureS3EventNotifications(stateMachine: stepfunctions.StateMachine, config: EnvironmentConfig): void {
    // Create IAM role for EventBridge to invoke Step Functions with least privilege
    const eventBridgeRole = new iam.Role(this, 'EventBridgeRole', {
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'IAM role for EventBridge to invoke Step Functions with least privilege',
      roleName: `EventBridge-Role-${config.environment}`,
    });

    // Grant EventBridge permission to start Step Functions execution (specific state machine only)
    eventBridgeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:StartExecution'],
      resources: [stateMachine.stateMachineArn],
      conditions: {
        StringEquals: {
          'aws:SourceAccount': this.account,
        },
      },
    }));

    // Add CloudWatch Logs permissions for EventBridge rule monitoring
    eventBridgeRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/events/rule/s3-spec-generator-trigger-${config.environment}:*`],
    }));

    // Create EventBridge rule to capture S3 events and trigger Step Functions
    const s3EventRule = new events.Rule(this, 'S3EventRule', {
      ruleName: `s3-spec-generator-trigger-${this.stackName}`,
      description: 'Trigger Step Functions when files are uploaded to input bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [this.inputBucket.bucketName],
          },
          object: {
            key: [
              // Include supported file formats and exclude system files
              { suffix: '.java' },
              { suffix: '.rexx' },
              { suffix: '.py' },
              { suffix: '.js' },
              { suffix: '.ts' },
            ],
          },
        },
      },
    });

    // Add Step Functions as target for the EventBridge rule with proper IAM role and error handling
    s3EventRule.addTarget(new targets.SfnStateMachine(stateMachine, {
      role: eventBridgeRole,
      input: events.RuleTargetInput.fromObject({
        bucket: events.EventField.fromPath('$.detail.bucket.name'),
        key: events.EventField.fromPath('$.detail.object.key'),
        size: events.EventField.fromPath('$.detail.object.size'),
        etag: events.EventField.fromPath('$.detail.object.etag'),
        eventTime: events.EventField.fromPath('$.time'),
        eventName: events.EventField.fromPath('$.detail-type'),
      }),
      deadLetterQueue: this.deadLetterQueue,
      maxEventAge: cdk.Duration.hours(2),
      retryAttempts: 3,
    }));

    // Enable EventBridge notifications on the S3 bucket
    this.inputBucket.enableEventBridgeNotification();

    // Add CloudWatch metric filter for monitoring rule invocations
    new logs.MetricFilter(this, 'S3EventRuleMetricFilter', {
      logGroup: this.logGroups.eventBridge,
      metricNamespace: `S3SpecGenerator/${config.environment}`,
      metricName: 'S3EventsProcessed',
      filterPattern: logs.FilterPattern.exists('$.detail.bucket.name'),
      metricValue: '1',
    });

    // Create CloudWatch alarm for failed Step Functions executions
    const failedExecutionsAlarm = new cloudwatch.Alarm(this, 'FailedExecutionsAlarm', {
      alarmName: `${config.stepFunctionName}-failed-executions`,
      alarmDescription: 'Alert when Step Functions executions fail',
      metric: stateMachine.metricFailed({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Send alarm notifications to SNS topic
    failedExecutionsAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.notificationTopic)
    );
  }

  /**
   * Create CloudWatch monitoring dashboard
   */
  private createMonitoringDashboard(config: EnvironmentConfig): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'S3SpecGeneratorDashboard', {
      dashboardName: `S3SpecGenerator-${config.environment}`,
    });

    const metricNamespace = `S3SpecGenerator/${config.environment}`;

    // Create widgets for the dashboard
    const executionMetricsWidget = new cloudwatch.GraphWidget({
      title: 'Step Functions Executions',
      left: [
        this.stateMachine.metricStarted({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        this.stateMachine.metricSucceeded({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        this.stateMachine.metricFailed({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
      ],
      width: 12,
      height: 6,
    });

    const processingTimeWidget = new cloudwatch.GraphWidget({
      title: 'Lambda Processing Times (seconds)',
      left: [
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'readFileProcessingTime',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'processWithClaudeProcessingTime',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'writeSpecificationProcessingTime',
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    const errorRateWidget = new cloudwatch.GraphWidget({
      title: 'Error Rates',
      left: [
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'readFileErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'processWithClaudeErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'writeSpecificationErrors',
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    const tokenUsageWidget = new cloudwatch.GraphWidget({
      title: 'Claude Token Usage',
      left: [
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'ClaudeInputTokens',
          statistic: 'Sum',
          period: cdk.Duration.minutes(15),
        }),
      ],
      right: [
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'ClaudeOutputTokens',
          statistic: 'Sum',
          period: cdk.Duration.minutes(15),
        }),
      ],
      width: 12,
      height: 6,
    });

    const fileVolumeWidget = new cloudwatch.SingleValueWidget({
      title: 'Files Processed (Last 24h)',
      metrics: [
        new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'FilesProcessed',
          statistic: 'Sum',
          period: cdk.Duration.hours(24),
        }),
      ],
      width: 6,
      height: 6,
    });

    const successRateWidget = new cloudwatch.SingleValueWidget({
      title: 'Success Rate (Last 24h)',
      metrics: [
        new cloudwatch.MathExpression({
          expression: '(success / (success + errors)) * 100',
          usingMetrics: {
            success: this.stateMachine.metricSucceeded({
              period: cdk.Duration.hours(24),
              statistic: 'Sum',
            }),
            errors: this.stateMachine.metricFailed({
              period: cdk.Duration.hours(24),
              statistic: 'Sum',
            }),
          },
        }),
      ],
      width: 6,
      height: 6,
    });

    // X-Ray service map widget
    const xrayServiceMapWidget = new cloudwatch.GraphWidget({
      title: 'X-Ray Trace Analytics',
      left: [
        new cloudwatch.Metric({
          namespace: 'AWS/X-Ray',
          metricName: 'TracesReceived',
          dimensionsMap: {
            ServiceName: `s3-spec-generator-${config.environment}`,
          },
          statistic: 'Sum',
          period: cdk.Duration.minutes(5),
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/X-Ray',
          metricName: 'ResponseTime',
          dimensionsMap: {
            ServiceName: `s3-spec-generator-${config.environment}`,
          },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
      ],
      width: 12,
      height: 6,
    });

    // System health summary widget
    const systemHealthWidget = new cloudwatch.SingleValueWidget({
      title: 'System Health Score',
      metrics: [
        new cloudwatch.MathExpression({
          expression: '100 - ((errors / total) * 100)',
          usingMetrics: {
            errors: this.stateMachine.metricFailed({
              period: cdk.Duration.hours(24),
              statistic: 'Sum',
            }),
            total: this.stateMachine.metricStarted({
              period: cdk.Duration.hours(24),
              statistic: 'Sum',
            }),
          },
        }),
      ],
      width: 6,
      height: 6,
    });

    // Add widgets to dashboard
    dashboard.addWidgets(executionMetricsWidget);
    dashboard.addWidgets(processingTimeWidget);
    dashboard.addWidgets(errorRateWidget);
    dashboard.addWidgets(tokenUsageWidget);
    dashboard.addWidgets(xrayServiceMapWidget);
    dashboard.addWidgets(fileVolumeWidget, successRateWidget);
    dashboard.addWidgets(systemHealthWidget);

    return dashboard;
  }



  /**
   * Configure X-Ray tracing for Lambda functions
   */
  private configureXRayTracing(config: EnvironmentConfig): void {
    // X-Ray tracing is enabled at the Lambda function level during deployment
    // This method creates X-Ray service map and sampling rules
    
    // Create X-Ray sampling rule for the application
    new cdk.CfnResource(this, 'XRaySamplingRule', {
      type: 'AWS::XRay::SamplingRule',
      properties: {
        SamplingRule: {
          RuleName: `S3SpecGenerator-${config.environment}`,
          Priority: 9000,
          FixedRate: 0.1, // Sample 10% of requests
          ReservoirSize: 1, // Always sample at least 1 request per second
          ServiceName: `s3-spec-generator-${config.environment}`,
          ServiceType: '*',
          Host: '*',
          HTTPMethod: '*',
          URLPath: '*',
          ResourceARN: '*',
          Version: 1,
        },
      },
    });

    // Create CloudWatch insights queries for X-Ray analysis
    this.createXRayInsightsQueries(config);
  }

  /**
   * Create CloudWatch Insights queries for X-Ray trace analysis
   */
  private createXRayInsightsQueries(config: EnvironmentConfig): void {
    // CloudWatch Insights queries can be created manually in the console using these patterns:
    
    // Slow traces query:
    // fields @timestamp, @message, @duration | filter @type = "REPORT" | filter @duration > 30000 | sort @timestamp desc | limit 20
    
    // Error traces query:
    // fields @timestamp, @message, @requestId | filter @message like /ERROR/ | sort @timestamp desc | limit 50
    
    // Token usage query:
    // fields @timestamp, @message | filter @message like /ClaudeInputTokens/ or @message like /ClaudeOutputTokens/ | stats sum(inputTokens), sum(outputTokens) by bin(5m)
    
    // Log the query patterns for reference
    console.log(`CloudWatch Insights queries available for ${config.environment} environment`);
  }

  /**
   * Create CloudWatch alarms for error rates and processing delays
   */
  private createCloudWatchAlarms(config: EnvironmentConfig): void {
    const metricNamespace = `S3SpecGenerator/${config.environment}`;

    // High error rate alarm
    const highErrorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-high-error-rate`,
      alarmDescription: 'Alert when error rate exceeds 10% over 15 minutes',
      metric: new cloudwatch.MathExpression({
        expression: '(errors / executions) * 100',
        usingMetrics: {
          errors: this.stateMachine.metricFailed({
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
          executions: this.stateMachine.metricStarted({
            period: cdk.Duration.minutes(15),
            statistic: 'Sum',
          }),
        },
      }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Processing delay alarm
    const processingDelayAlarm = new cloudwatch.Alarm(this, 'ProcessingDelayAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-processing-delay`,
      alarmDescription: 'Alert when Step Functions execution time exceeds 8 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName: 'ExecutionTime',
        dimensionsMap: {
          StateMachineArn: this.stateMachine.stateMachineArn,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 480, // 8 minutes in seconds
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Claude processing time alarm
    const claudeProcessingAlarm = new cloudwatch.Alarm(this, 'ClaudeProcessingAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-claude-slow`,
      alarmDescription: 'Alert when Claude processing takes longer than 4 minutes on average',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'processWithClaudeProcessingTime',
        statistic: 'Average',
        period: cdk.Duration.minutes(10),
      }),
      threshold: 240, // 4 minutes in seconds
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Dead letter queue alarm
    const dlqAlarm = new cloudwatch.Alarm(this, 'DeadLetterQueueAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-dlq-messages`,
      alarmDescription: 'Alert when messages appear in dead letter queue',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfVisibleMessages',
        dimensionsMap: {
          QueueName: this.deadLetterQueue.queueName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Token usage alarm - alert when token usage is high
    const highTokenUsageAlarm = new cloudwatch.Alarm(this, 'HighTokenUsageAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-high-token-usage`,
      alarmDescription: 'Alert when Claude token usage exceeds threshold',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'ClaudeInputTokens',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 50000, // Alert if more than 50k tokens per hour
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // File processing volume alarm
    const highVolumeAlarm = new cloudwatch.Alarm(this, 'HighVolumeAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-high-volume`,
      alarmDescription: 'Alert when file processing volume is unusually high',
      metric: new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: 'FilesProcessed',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 100, // Alert if more than 100 files per hour
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda memory utilization alarm (composite)
    const memoryUtilizationAlarm = new cloudwatch.Alarm(this, 'MemoryUtilizationAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-memory-utilization`,
      alarmDescription: 'Alert when Lambda memory utilization is consistently high',
      metric: new cloudwatch.MathExpression({
        expression: '(readFile + processWithClaude + writeSpecification) / 3',
        usingMetrics: {
          readFile: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: {
              FunctionName: `ReadFileFunction-${config.environment}`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          processWithClaude: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: {
              FunctionName: `ProcessWithClaudeFunction-${config.environment}`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
          writeSpecification: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: {
              FunctionName: `WriteSpecificationFunction-${config.environment}`,
            },
            statistic: 'Average',
            period: cdk.Duration.minutes(5),
          }),
        },
      }),
      threshold: 240000, // 4 minutes average across functions
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // S3 bucket size alarm for input bucket (prevent runaway storage costs)
    const inputBucketSizeAlarm = new cloudwatch.Alarm(this, 'InputBucketSizeAlarm', {
      alarmName: `${config.environment}-s3-spec-generator-input-bucket-size`,
      alarmDescription: 'Alert when input bucket size exceeds threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/S3',
        metricName: 'BucketSizeBytes',
        dimensionsMap: {
          BucketName: this.inputBucket.bucketName,
          StorageType: 'StandardStorage',
        },
        statistic: 'Average',
        period: cdk.Duration.hours(24),
      }),
      threshold: 1024 * 1024 * 1024 * 5, // 5GB
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Composite alarm for system health
    const systemHealthAlarm = new cloudwatch.CompositeAlarm(this, 'SystemHealthAlarm', {
      compositeAlarmName: `${config.environment}-s3-spec-generator-system-health`,
      alarmDescription: 'Composite alarm indicating overall system health issues',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        cloudwatch.AlarmRule.fromAlarm(highErrorRateAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(processingDelayAlarm, cloudwatch.AlarmState.ALARM),
        cloudwatch.AlarmRule.fromAlarm(dlqAlarm, cloudwatch.AlarmState.ALARM)
      ),
    });

    // Add SNS actions to all alarms
    const alarms = [
      highErrorRateAlarm, 
      processingDelayAlarm, 
      claudeProcessingAlarm, 
      dlqAlarm,
      highTokenUsageAlarm,
      highVolumeAlarm,
      memoryUtilizationAlarm,
      inputBucketSizeAlarm,
      systemHealthAlarm
    ];
    
    alarms.forEach(alarm => {
      if (alarm instanceof cloudwatch.Alarm) {
        alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.notificationTopic));
      }
    });

    // Add OK actions for critical alarms to notify when issues are resolved
    [highErrorRateAlarm, processingDelayAlarm, systemHealthAlarm].forEach(alarm => {
      if (alarm instanceof cloudwatch.Alarm) {
        alarm.addOkAction(new cloudwatchActions.SnsAction(this.notificationTopic));
      }
    });
  }

  /**
   * Configure SNS subscriptions for notifications
   */
  private configureSNSSubscriptions(config: EnvironmentConfig): void {
    // Add email subscription if email is provided in config
    if (config.notificationEmail) {
      new sns.Subscription(this, 'EmailSubscription', {
        topic: this.notificationTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: config.notificationEmail,
      });
    }


  }
}