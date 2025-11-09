/**
 * Security Configuration for S3 Specification Generator
 * 
 * This file documents and centralizes all security configurations
 * implemented across the infrastructure stack.
 */

export interface SecurityConfig {
  environment: string;
  encryption: EncryptionConfig;
  access: AccessConfig;
  monitoring: MonitoringConfig;
  compliance: ComplianceConfig;
}

export interface EncryptionConfig {
  s3: {
    serverSideEncryption: 'AES256' | 'aws:kms';
    enforceSSL: boolean;
    keyRotation: boolean;
  };
  lambda: {
    environmentVariables: boolean;
    kmsKeyId?: string;
  };
  cloudWatch: {
    logEncryption: boolean;
  };
}

export interface AccessConfig {
  s3: {
    blockPublicAccess: boolean;
    bucketPolicies: boolean;
    corsRestrictions: boolean;
    accessLogging: boolean;
  };
  iam: {
    leastPrivilege: boolean;
    roleBasedAccess: boolean;
    crossAccountAccess: boolean;
  };
  network: {
    vpcEndpoints: boolean;
    privateSubnets: boolean;
  };
}

export interface MonitoringConfig {
  cloudTrail: {
    enabled: boolean;
    s3DataEvents: boolean;
    managementEvents: boolean;
  };
  cloudWatch: {
    securityMetrics: boolean;
    alarms: boolean;
    dashboards: boolean;
  };
  eventBridge: {
    securityEvents: boolean;
    complianceEvents: boolean;
  };
}

export interface ComplianceConfig {
  awsConfig: {
    enabled: boolean;
    rules: string[];
  };
  securityHub: {
    enabled: boolean;
    standards: string[];
  };
  inspector: {
    enabled: boolean;
    assessmentTargets: string[];
  };
}

/**
 * Get security configuration based on environment
 */
export function getSecurityConfig(environment: string): SecurityConfig {
  const baseConfig: SecurityConfig = {
    environment,
    encryption: {
      s3: {
        serverSideEncryption: 'AES256',
        enforceSSL: true,
        keyRotation: true,
      },
      lambda: {
        environmentVariables: true,
      },
      cloudWatch: {
        logEncryption: true,
      },
    },
    access: {
      s3: {
        blockPublicAccess: true,
        bucketPolicies: true,
        corsRestrictions: true,
        accessLogging: true,
      },
      iam: {
        leastPrivilege: true,
        roleBasedAccess: true,
        crossAccountAccess: false,
      },
      network: {
        vpcEndpoints: false, // Can be enabled for enhanced security
        privateSubnets: false, // Can be enabled for enhanced security
      },
    },
    monitoring: {
      cloudTrail: {
        enabled: true,
        s3DataEvents: true,
        managementEvents: true,
      },
      cloudWatch: {
        securityMetrics: true,
        alarms: true,
        dashboards: true,
      },
      eventBridge: {
        securityEvents: true,
        complianceEvents: true,
      },
    },
    compliance: {
      awsConfig: {
        enabled: true,
        rules: [
          's3-bucket-server-side-encryption-enabled',
          's3-bucket-public-access-prohibited',
          'lambda-function-settings-check',
          'iam-policy-no-statements-with-admin-access',
        ],
      },
      securityHub: {
        enabled: environment === 'prod',
        standards: ['aws-foundational-security-standard'],
      },
      inspector: {
        enabled: environment === 'prod',
        assessmentTargets: ['lambda-functions'],
      },
    },
  };

  // Environment-specific overrides
  switch (environment) {
    case 'prod':
      return {
        ...baseConfig,
        encryption: {
          ...baseConfig.encryption,
          s3: {
            ...baseConfig.encryption.s3,
            serverSideEncryption: 'aws:kms', // Use KMS for production
          },
        },
        access: {
          ...baseConfig.access,
          network: {
            vpcEndpoints: true,
            privateSubnets: true,
          },
        },
      };
    case 'staging':
      return {
        ...baseConfig,
        compliance: {
          ...baseConfig.compliance,
          securityHub: {
            enabled: true,
            standards: ['aws-foundational-security-standard'],
          },
        },
      };
    default:
      return baseConfig;
  }
}

/**
 * Security best practices checklist
 */
export const SECURITY_CHECKLIST = {
  encryption: [
    'S3 buckets use server-side encryption (AES256 or KMS)',
    'SSL/TLS enforced for all S3 requests',
    'Lambda environment variables encrypted',
    'CloudWatch logs encrypted',
  ],
  access: [
    'S3 buckets block all public access',
    'IAM roles follow least privilege principle',
    'Bucket policies restrict access to authorized principals only',
    'CORS configured with restrictive origins',
    'Access logging enabled for audit trails',
  ],
  monitoring: [
    'CloudTrail enabled for API call monitoring',
    'CloudWatch alarms for security events',
    'EventBridge rules for policy changes',
    'Security metrics and dashboards configured',
  ],
  compliance: [
    'AWS Config rules for compliance monitoring',
    'Security Hub enabled (production)',
    'Inspector assessments configured',
    'Regular security reviews scheduled',
  ],
  network: [
    'VPC endpoints for private communication (optional)',
    'Private subnets for Lambda functions (optional)',
    'Security groups with minimal required access',
    'NACLs configured for additional protection',
  ],
};

/**
 * Security incident response procedures
 */
export const INCIDENT_RESPONSE = {
  detection: [
    'Monitor CloudWatch alarms for security events',
    'Review CloudTrail logs for suspicious activity',
    'Check AWS Config compliance status',
    'Monitor SNS notifications for security alerts',
  ],
  response: [
    'Isolate affected resources',
    'Revoke compromised credentials',
    'Update IAM policies to restrict access',
    'Enable additional logging and monitoring',
  ],
  recovery: [
    'Restore from secure backups',
    'Update security configurations',
    'Implement additional controls',
    'Conduct post-incident review',
  ],
  prevention: [
    'Regular security assessments',
    'Automated compliance monitoring',
    'Security training for team members',
    'Keep security configurations up to date',
  ],
};