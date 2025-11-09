#!/usr/bin/env node

/**
 * Security Validation Script for S3 Specification Generator
 * 
 * This script validates that all security configurations are properly implemented
 * and provides recommendations for improvements.
 */

// AWS SDK imports - install with: npm install @aws-sdk/client-s3 @aws-sdk/client-iam @aws-sdk/client-cloudwatch-logs
// These are optional dependencies for the validation script
let S3Client: any, GetBucketEncryptionCommand: any, GetBucketPolicyCommand: any, GetPublicAccessBlockCommand: any;
let IAMClient: any, GetRoleCommand: any, ListAttachedRolePoliciesCommand: any;
let CloudWatchLogsClient: any, DescribeLogGroupsCommand: any;

try {
  const s3Module = require('@aws-sdk/client-s3');
  S3Client = s3Module.S3Client;
  GetBucketEncryptionCommand = s3Module.GetBucketEncryptionCommand;
  GetBucketPolicyCommand = s3Module.GetBucketPolicyCommand;
  GetPublicAccessBlockCommand = s3Module.GetPublicAccessBlockCommand;

  const iamModule = require('@aws-sdk/client-iam');
  IAMClient = iamModule.IAMClient;
  GetRoleCommand = iamModule.GetRoleCommand;
  ListAttachedRolePoliciesCommand = iamModule.ListAttachedRolePoliciesCommand;

  const logsModule = require('@aws-sdk/client-cloudwatch-logs');
  CloudWatchLogsClient = logsModule.CloudWatchLogsClient;
  DescribeLogGroupsCommand = logsModule.DescribeLogGroupsCommand;
} catch (error) {
  console.warn('AWS SDK modules not found. Install with: npm install @aws-sdk/client-s3 @aws-sdk/client-iam @aws-sdk/client-cloudwatch-logs');
}

interface SecurityValidationResult {
  passed: boolean;
  message: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  recommendation?: string;
}

interface ValidationReport {
  environment: string;
  timestamp: string;
  overallScore: number;
  results: SecurityValidationResult[];
  summary: {
    passed: number;
    failed: number;
    warnings: number;
  };
}

class SecurityValidator {
  private s3Client: any;
  private iamClient: any;
  private logsClient: any;
  private environment: string;

  constructor(environment: string, region: string = 'us-east-1') {
    this.environment = environment;
    
    if (S3Client && IAMClient && CloudWatchLogsClient) {
      this.s3Client = new S3Client({ region });
      this.iamClient = new IAMClient({ region });
      this.logsClient = new CloudWatchLogsClient({ region });
    } else {
      throw new Error('AWS SDK modules not available. Please install the required dependencies.');
    }
  }

  /**
   * Run complete security validation
   */
  async validateSecurity(): Promise<ValidationReport> {
    const results: SecurityValidationResult[] = [];

    // Validate S3 bucket security
    results.push(...await this.validateS3Security());

    // Validate IAM roles and policies
    results.push(...await this.validateIAMSecurity());

    // Validate CloudWatch logging
    results.push(...await this.validateLoggingSecurity());

    // Calculate summary
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed && r.severity === 'HIGH').length;
    const warnings = results.filter(r => !r.passed && r.severity !== 'HIGH').length;

    const overallScore = Math.round((passed / results.length) * 100);

    return {
      environment: this.environment,
      timestamp: new Date().toISOString(),
      overallScore,
      results,
      summary: { passed, failed, warnings },
    };
  }

  /**
   * Validate S3 bucket security configurations
   */
  private async validateS3Security(): Promise<SecurityValidationResult[]> {
    const results: SecurityValidationResult[] = [];
    const buckets = [
      `spec-generator-input-${this.environment}`,
      `spec-generator-output-${this.environment}`,
    ];

    for (const bucketName of buckets) {
      try {
        // Check bucket encryption
        try {
          const encryptionResult = await this.s3Client.send(
            new GetBucketEncryptionCommand({ Bucket: bucketName })
          );
          
          if (encryptionResult.ServerSideEncryptionConfiguration?.Rules) {
            results.push({
              passed: true,
              message: `Bucket ${bucketName} has server-side encryption enabled`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Bucket ${bucketName} does not have server-side encryption configured`,
              severity: 'HIGH',
              recommendation: 'Enable server-side encryption (AES256 or KMS)',
            });
          }
        } catch (error) {
          results.push({
            passed: false,
            message: `Could not verify encryption for bucket ${bucketName}`,
            severity: 'HIGH',
            recommendation: 'Ensure bucket exists and has proper encryption configuration',
          });
        }

        // Check public access block
        try {
          const publicAccessResult = await this.s3Client.send(
            new GetPublicAccessBlockCommand({ Bucket: bucketName })
          );
          
          const config = publicAccessResult.PublicAccessBlockConfiguration;
          if (config?.BlockPublicAcls && config?.BlockPublicPolicy && 
              config?.IgnorePublicAcls && config?.RestrictPublicBuckets) {
            results.push({
              passed: true,
              message: `Bucket ${bucketName} has all public access blocked`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Bucket ${bucketName} does not have all public access blocked`,
              severity: 'HIGH',
              recommendation: 'Enable all public access block settings',
            });
          }
        } catch (error) {
          results.push({
            passed: false,
            message: `Could not verify public access block for bucket ${bucketName}`,
            severity: 'MEDIUM',
            recommendation: 'Verify bucket exists and check public access block configuration',
          });
        }

        // Check bucket policy
        try {
          const policyResult = await this.s3Client.send(
            new GetBucketPolicyCommand({ Bucket: bucketName })
          );
          
          if (policyResult.Policy) {
            const policy = JSON.parse(policyResult.Policy);
            const hasSSLEnforcement = policy.Statement?.some((stmt: any) => 
              stmt.Effect === 'Deny' && 
              stmt.Condition?.Bool?.['aws:SecureTransport'] === 'false'
            );
            
            if (hasSSLEnforcement) {
              results.push({
                passed: true,
                message: `Bucket ${bucketName} enforces SSL/TLS connections`,
                severity: 'INFO',
              });
            } else {
              results.push({
                passed: false,
                message: `Bucket ${bucketName} does not enforce SSL/TLS connections`,
                severity: 'MEDIUM',
                recommendation: 'Add bucket policy to deny non-SSL requests',
              });
            }
          }
        } catch (error) {
          // No bucket policy is not necessarily an error, but SSL enforcement is recommended
          results.push({
            passed: false,
            message: `Bucket ${bucketName} does not have a bucket policy for SSL enforcement`,
            severity: 'MEDIUM',
            recommendation: 'Add bucket policy to enforce SSL/TLS connections',
          });
        }
      } catch (error) {
        results.push({
          passed: false,
          message: `Failed to validate bucket ${bucketName}: ${error}`,
          severity: 'HIGH',
          recommendation: 'Verify bucket exists and check AWS credentials',
        });
      }
    }

    return results;
  }

  /**
   * Validate IAM roles and policies
   */
  private async validateIAMSecurity(): Promise<SecurityValidationResult[]> {
    const results: SecurityValidationResult[] = [];
    const roles = [
      `ReadFileFunction-Role-${this.environment}`,
      `ProcessWithClaudeFunction-Role-${this.environment}`,
      `WriteSpecificationFunction-Role-${this.environment}`,
      `SendNotificationFunction-Role-${this.environment}`,
      `StateMachine-Role-${this.environment}`,
    ];

    for (const roleName of roles) {
      try {
        // Check if role exists
        const roleResult = await this.iamClient.send(
          new GetRoleCommand({ RoleName: roleName })
        );

        if (roleResult.Role) {
          results.push({
            passed: true,
            message: `IAM role ${roleName} exists`,
            severity: 'INFO',
          });

          // Check attached policies
          const policiesResult = await this.iamClient.send(
            new ListAttachedRolePoliciesCommand({ RoleName: roleName })
          );

          const hasBasicExecution = policiesResult.AttachedPolicies?.some(
            (policy: any) => policy.PolicyName === 'AWSLambdaBasicExecutionRole'
          );

          if (hasBasicExecution) {
            results.push({
              passed: true,
              message: `Role ${roleName} has basic execution permissions`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Role ${roleName} missing basic execution permissions`,
              severity: 'MEDIUM',
              recommendation: 'Attach AWSLambdaBasicExecutionRole managed policy',
            });
          }

          // Check for overly permissive policies
          const hasAdminAccess = policiesResult.AttachedPolicies?.some(
            (policy: any) => policy.PolicyName?.includes('Admin') || policy.PolicyName?.includes('FullAccess')
          );

          if (!hasAdminAccess) {
            results.push({
              passed: true,
              message: `Role ${roleName} follows least privilege principle`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Role ${roleName} has overly permissive policies`,
              severity: 'HIGH',
              recommendation: 'Remove admin/full access policies and use least privilege',
            });
          }
        }
      } catch (error) {
        results.push({
          passed: false,
          message: `Could not validate IAM role ${roleName}: ${error}`,
          severity: 'HIGH',
          recommendation: 'Verify role exists and check IAM permissions',
        });
      }
    }

    return results;
  }

  /**
   * Validate CloudWatch logging security
   */
  private async validateLoggingSecurity(): Promise<SecurityValidationResult[]> {
    const results: SecurityValidationResult[] = [];
    const logGroups = [
      `/aws/lambda/ReadFileFunction-${this.environment}`,
      `/aws/lambda/ProcessWithClaudeFunction-${this.environment}`,
      `/aws/lambda/WriteSpecificationFunction-${this.environment}`,
      `/aws/lambda/SendNotificationFunction-${this.environment}`,
      `/aws/stepfunctions/spec-generator-workflow-${this.environment}`,
    ];

    try {
      const logGroupsResult = await this.logsClient.send(
        new DescribeLogGroupsCommand({})
      );

      for (const expectedLogGroup of logGroups) {
        const logGroup = logGroupsResult.logGroups?.find(
          (lg: any) => lg.logGroupName === expectedLogGroup
        );

        if (logGroup) {
          results.push({
            passed: true,
            message: `Log group ${expectedLogGroup} exists`,
            severity: 'INFO',
          });

          // Check retention period
          if (logGroup.retentionInDays && logGroup.retentionInDays <= 7) {
            results.push({
              passed: true,
              message: `Log group ${expectedLogGroup} has appropriate retention period`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Log group ${expectedLogGroup} has excessive retention period`,
              severity: 'LOW',
              recommendation: 'Set retention period to 7 days or less for cost optimization',
            });
          }

          // Check encryption
          if (logGroup.kmsKeyId) {
            results.push({
              passed: true,
              message: `Log group ${expectedLogGroup} is encrypted`,
              severity: 'INFO',
            });
          } else {
            results.push({
              passed: false,
              message: `Log group ${expectedLogGroup} is not encrypted`,
              severity: 'MEDIUM',
              recommendation: 'Enable CloudWatch Logs encryption with KMS',
            });
          }
        } else {
          results.push({
            passed: false,
            message: `Log group ${expectedLogGroup} does not exist`,
            severity: 'MEDIUM',
            recommendation: 'Create log group with proper configuration',
          });
        }
      }
    } catch (error) {
      results.push({
        passed: false,
        message: `Could not validate CloudWatch log groups: ${error}`,
        severity: 'MEDIUM',
        recommendation: 'Check CloudWatch Logs permissions and configuration',
      });
    }

    return results;
  }

  /**
   * Generate security report
   */
  generateReport(report: ValidationReport): string {
    let output = `
# Security Validation Report
**Environment:** ${report.environment}
**Timestamp:** ${report.timestamp}
**Overall Score:** ${report.overallScore}%

## Summary
- ✅ Passed: ${report.summary.passed}
- ❌ Failed: ${report.summary.failed}
- ⚠️  Warnings: ${report.summary.warnings}

## Detailed Results
`;

    for (const result of report.results) {
      const icon = result.passed ? '✅' : 
                   result.severity === 'HIGH' ? '❌' : 
                   result.severity === 'MEDIUM' ? '⚠️' : 'ℹ️';
      
      output += `\n${icon} **${result.severity}**: ${result.message}`;
      
      if (result.recommendation) {
        output += `\n   💡 *Recommendation: ${result.recommendation}*`;
      }
      output += '\n';
    }

    if (report.overallScore < 80) {
      output += `\n## ⚠️ Action Required
Your security score is below 80%. Please address the high and medium severity issues above.`;
    } else if (report.overallScore < 95) {
      output += `\n## 👍 Good Security Posture
Your security score is good, but there are some improvements that can be made.`;
    } else {
      output += `\n## 🎉 Excellent Security Posture
Your security configuration meets best practices!`;
    }

    return output;
  }
}

/**
 * Main execution function
 */
async function main() {
  const environment = process.argv[2] || 'dev';
  const region = process.argv[3] || 'us-east-1';

  console.log(`🔒 Running security validation for environment: ${environment}`);
  
  const validator = new SecurityValidator(environment, region);
  
  try {
    const report = await validator.validateSecurity();
    const reportText = validator.generateReport(report);
    
    console.log(reportText);
    
    // Exit with error code if security score is too low
    if (report.overallScore < 80) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Security validation failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { SecurityValidator, ValidationReport, SecurityValidationResult };