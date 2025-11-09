export interface EnvironmentConfig {
  environment: string;
  inputBucketName: string;
  outputBucketName: string;
  notificationTopicName: string;
  stepFunctionName: string;
  lambdaTimeout: number;
  lambdaMemorySize: {
    readFile: number;
    processWithClaude: number;
    writeSpecification: number;
    sendNotification: number;
  };
  fileRetentionDays: number;
  maxFileSize: number;
  claudeModel: string;
  notificationEmail?: string;
  tags: Record<string, string>;
  resourceNaming: {
    prefix: string;
    suffix: string;
    separator: string;
  };
  deployment: {
    requireApproval: boolean;
    enableTerminationProtection: boolean;
    enableRollback: boolean;
  };
  monitoring: {
    enableDetailedMonitoring: boolean;
    logRetentionDays: number;
    enableXRayTracing: boolean;
  };
}

export function getConfig(): EnvironmentConfig {
  const environment = process.env.ENVIRONMENT || 'dev';
  
  const baseConfig: EnvironmentConfig = {
    environment,
    inputBucketName: `spec-generator-input-${environment}`,
    outputBucketName: `spec-generator-output-${environment}`,
    notificationTopicName: `spec-generator-notifications-${environment}`,
    stepFunctionName: `spec-generator-workflow-${environment}`,
    lambdaTimeout: 300, // 5 minutes
    lambdaMemorySize: {
      readFile: 512,
      processWithClaude: 1024,
      writeSpecification: 256,
      sendNotification: 256,
    },
    fileRetentionDays: 7,
    maxFileSize: 10 * 1024 * 1024, // 10MB in bytes
    claudeModel: 'anthropic.claude-3-sonnet-20240229-v1:0',
    notificationEmail: process.env.NOTIFICATION_EMAIL,
    tags: {
      Project: 'S3SpecGenerator',
      Environment: environment,
      Owner: process.env.RESOURCE_OWNER || 'DevTeam',
      CostCenter: process.env.COST_CENTER || 'Engineering',
      ManagedBy: 'CDK',
      Repository: 's3-spec-generator',
    },
    resourceNaming: {
      prefix: 'spec-generator',
      suffix: environment,
      separator: '-',
    },
    deployment: {
      requireApproval: environment === 'prod',
      enableTerminationProtection: environment === 'prod',
      enableRollback: true,
    },
    monitoring: {
      enableDetailedMonitoring: environment !== 'dev',
      logRetentionDays: environment === 'prod' ? 30 : 7,
      enableXRayTracing: true,
    },
  };

  // Environment-specific overrides
  switch (environment) {
    case 'prod':
      return {
        ...baseConfig,
        lambdaMemorySize: {
          readFile: 1024,
          processWithClaude: 2048,
          writeSpecification: 512,
          sendNotification: 512,
        },
        fileRetentionDays: 30,
        tags: {
          ...baseConfig.tags,
          Owner: 'ProductionTeam',
          CostCenter: 'Operations',
          Backup: 'required',
          Compliance: 'required',
        },
        deployment: {
          requireApproval: true,
          enableTerminationProtection: true,
          enableRollback: true,
        },
        monitoring: {
          enableDetailedMonitoring: true,
          logRetentionDays: 90,
          enableXRayTracing: true,
        },
      };
    case 'staging':
      return {
        ...baseConfig,
        lambdaMemorySize: {
          readFile: 768,
          processWithClaude: 1536,
          writeSpecification: 384,
          sendNotification: 384,
        },
        fileRetentionDays: 14,
        tags: {
          ...baseConfig.tags,
          Backup: 'enabled',
        },
        deployment: {
          requireApproval: false,
          enableTerminationProtection: false,
          enableRollback: true,
        },
        monitoring: {
          enableDetailedMonitoring: true,
          logRetentionDays: 14,
          enableXRayTracing: true,
        },
      };
    default:
      return {
        ...baseConfig,
        tags: {
          ...baseConfig.tags,
          Backup: 'disabled',
        },
        deployment: {
          requireApproval: false,
          enableTerminationProtection: false,
          enableRollback: false,
        },
        monitoring: {
          enableDetailedMonitoring: false,
          logRetentionDays: 3,
          enableXRayTracing: false,
        },
      };
  }
}

/**
 * Generate a standardized resource name based on configuration
 */
export function generateResourceName(config: EnvironmentConfig, resourceType: string, resourceName?: string): string {
  const parts = [config.resourceNaming.prefix];
  
  if (resourceName) {
    parts.push(resourceName);
  }
  
  parts.push(resourceType, config.resourceNaming.suffix);
  
  return parts.join(config.resourceNaming.separator);
}

/**
 * Validate configuration for deployment
 */
export function validateConfig(config: EnvironmentConfig): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validate environment
  if (!['dev', 'staging', 'prod'].includes(config.environment)) {
    errors.push(`Invalid environment: ${config.environment}`);
  }
  
  // Validate bucket names (S3 naming rules)
  const bucketNameRegex = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
  if (!bucketNameRegex.test(config.inputBucketName)) {
    errors.push(`Invalid input bucket name: ${config.inputBucketName}`);
  }
  if (!bucketNameRegex.test(config.outputBucketName)) {
    errors.push(`Invalid output bucket name: ${config.outputBucketName}`);
  }
  
  // Validate Lambda memory sizes
  Object.entries(config.lambdaMemorySize).forEach(([funcName, memorySize]) => {
    if (memorySize < 128 || memorySize > 10240) {
      errors.push(`Invalid memory size for ${funcName}: ${memorySize} (must be 128-10240 MB)`);
    }
    if (memorySize % 64 !== 0) {
      errors.push(`Memory size for ${funcName} must be multiple of 64 MB: ${memorySize}`);
    }
  });
  
  // Validate timeout
  if (config.lambdaTimeout < 1 || config.lambdaTimeout > 900) {
    errors.push(`Invalid Lambda timeout: ${config.lambdaTimeout} (must be 1-900 seconds)`);
  }
  
  // Validate file retention
  if (config.fileRetentionDays < 1 || config.fileRetentionDays > 365) {
    errors.push(`Invalid file retention days: ${config.fileRetentionDays} (must be 1-365 days)`);
  }
  
  // Validate max file size
  if (config.maxFileSize < 1024 || config.maxFileSize > 52428800) { // 1KB to 50MB
    errors.push(`Invalid max file size: ${config.maxFileSize} (must be 1KB-50MB)`);
  }
  
  // Validate required tags
  const requiredTags = ['Project', 'Environment', 'Owner'];
  requiredTags.forEach(tag => {
    if (!config.tags[tag]) {
      errors.push(`Missing required tag: ${tag}`);
    }
  });
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}