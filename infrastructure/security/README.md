# Security Implementation for S3 Specification Generator

This directory contains the security configuration and validation tools for the S3 Specification Generator project.

## Overview

The security implementation follows AWS security best practices and implements defense-in-depth principles across all components of the system.

## Security Features Implemented

### 1. IAM Roles and Policies (Task 8.1)

#### Least Privilege Access
- **ReadFileFunction Role**: Only has permissions to read from the input S3 bucket
- **ProcessWithClaudeFunction Role**: Only has permissions to invoke specific Bedrock models
- **WriteSpecificationFunction Role**: Only has permissions to write to the output S3 bucket
- **SendNotificationFunction Role**: Only has permissions to publish to the specific SNS topic
- **StateMachine Role**: Only has permissions to invoke the specific Lambda functions

#### Key Security Features:
- ✅ Least privilege principle enforced
- ✅ Resource-specific permissions (no wildcards)
- ✅ Conditional access controls
- ✅ X-Ray tracing permissions for monitoring
- ✅ CloudWatch logging permissions scoped to specific log groups

### 2. S3 Bucket Security and Encryption (Task 8.2)

#### Encryption
- ✅ Server-side encryption (AES256) enabled on all buckets
- ✅ SSL/TLS enforcement for all requests
- ✅ Encryption validation in bucket policies

#### Access Control
- ✅ Block all public access enabled
- ✅ Bucket policies restrict access to authorized principals only
- ✅ CORS configured with restrictive origins (non-production only)
- ✅ Object ownership enforced

#### Monitoring and Logging
- ✅ Access logging enabled for audit trails
- ✅ CloudWatch metrics for security events
- ✅ EventBridge rules for policy changes
- ✅ Security alarms for suspicious activity

#### Lifecycle Management
- ✅ Automatic deletion of processed files (7 days)
- ✅ Incomplete multipart upload cleanup
- ✅ Cost-optimized storage transitions for output bucket

## Files in this Directory

### `security-config.ts`
Centralized security configuration that defines:
- Encryption settings
- Access control policies
- Monitoring configurations
- Compliance requirements
- Environment-specific overrides

### `validate-security.ts`
Automated security validation script that checks:
- S3 bucket encryption and public access settings
- IAM role configurations and policy compliance
- CloudWatch logging setup
- Security best practices adherence

### `README.md` (this file)
Documentation of security implementation and usage instructions.

## Usage

### Running Security Validation

```bash
# Install required dependencies
npm install @aws-sdk/client-s3 @aws-sdk/client-iam @aws-sdk/client-cloudwatch-logs

# Run validation for development environment
npx ts-node infrastructure/security/validate-security.ts dev

# Run validation for production environment
npx ts-node infrastructure/security/validate-security.ts prod us-east-1
```

### Security Configuration

The security configuration is automatically applied when deploying the CDK stack:

```bash
# Deploy with security configurations
cdk deploy --context environment=prod
```

## Security Checklist

### ✅ Completed
- [x] IAM roles follow least privilege principle
- [x] S3 buckets have server-side encryption enabled
- [x] SSL/TLS enforced for all S3 requests
- [x] Public access blocked on all buckets
- [x] Access logging enabled for audit trails
- [x] CloudWatch monitoring and alarms configured
- [x] Security metric filters implemented
- [x] EventBridge rules for security events
- [x] Compliance monitoring with AWS Config rules
- [x] Automated security validation script

### 🔄 Optional Enhancements
- [ ] Customer-managed KMS keys (currently using S3-managed encryption)
- [ ] VPC endpoints for private communication
- [ ] AWS Security Hub integration
- [ ] AWS Inspector assessments
- [ ] GuardDuty integration
- [ ] CloudTrail data events logging

## Security Monitoring

### CloudWatch Alarms
- Failed authentication attempts (>5 in 5 minutes)
- Suspicious file access patterns
- Large file uploads (>5MB)
- High error rates (>10% in 15 minutes)
- Processing delays (>8 minutes average)

### EventBridge Rules
- S3 bucket policy changes
- IAM role policy modifications
- Security configuration changes

### Compliance Rules (AWS Config)
- S3 bucket encryption compliance
- Public access prohibition
- Lambda function security settings
- IAM policy compliance

## Incident Response

### Detection
1. Monitor CloudWatch alarms for security events
2. Review CloudTrail logs for suspicious activity
3. Check AWS Config compliance status
4. Monitor SNS notifications for security alerts

### Response
1. Isolate affected resources
2. Revoke compromised credentials
3. Update IAM policies to restrict access
4. Enable additional logging and monitoring

### Recovery
1. Restore from secure backups
2. Update security configurations
3. Implement additional controls
4. Conduct post-incident review

## Security Best Practices

### Development
- Always test security configurations in non-production environments
- Use the security validation script before deployments
- Review IAM policies regularly for least privilege compliance
- Monitor security metrics and alarms

### Production
- Enable all security features and monitoring
- Use customer-managed KMS keys for sensitive data
- Implement VPC endpoints for private communication
- Regular security assessments and penetration testing

### Maintenance
- Keep security configurations up to date
- Review and rotate access keys regularly
- Monitor for new security best practices
- Update compliance rules as needed

## Troubleshooting

### Common Issues

1. **Permission Denied Errors**
   - Check IAM role policies for required permissions
   - Verify resource ARNs in policy statements
   - Ensure conditions are not overly restrictive

2. **S3 Access Issues**
   - Verify bucket policies allow required actions
   - Check public access block settings
   - Ensure SSL/TLS is being used for requests

3. **Monitoring Gaps**
   - Verify CloudWatch log groups exist
   - Check metric filter configurations
   - Ensure EventBridge rules are enabled

### Getting Help

- Review CloudWatch logs for detailed error information
- Use the security validation script to identify issues
- Check AWS documentation for service-specific security requirements
- Contact the security team for policy reviews

## References

- [AWS Security Best Practices](https://aws.amazon.com/architecture/security-identity-compliance/)
- [S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [Lambda Security Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/lambda-security.html)