# S3 Spec Generator Deployment

This directory contains deployment configurations, scripts, and documentation for the S3 Specification Generator infrastructure.

## Directory Structure

```
deployment/
├── environments/           # Environment-specific configuration files
│   ├── dev.json           # Development environment config
│   ├── staging.json       # Staging environment config
│   └── prod.json          # Production environment config
├── env-templates/         # Environment variable templates
│   ├── .env.dev.template  # Development environment variables
│   ├── .env.staging.template # Staging environment variables
│   └── .env.prod.template # Production environment variables
├── DEPLOYMENT_CHECKLIST.md # Comprehensive deployment checklist
└── README.md             # This file
```

## Quick Start

### 1. Choose Your Environment

```bash
# Development
export ENVIRONMENT=dev

# Staging
export ENVIRONMENT=staging

# Production
export ENVIRONMENT=prod
```

### 2. Validate Configuration

```bash
npm run validate:config -- -e $ENVIRONMENT
```

### 3. Deploy Infrastructure

```bash
npm run deploy:$ENVIRONMENT
```

### 4. Validate Deployment

```bash
npm run validate:$ENVIRONMENT
```

## Available Scripts

### Configuration Management
- `npm run config:show` - Show configuration for environment
- `npm run config:validate` - Validate configuration
- `npm run config:tags` - Generate resource tags
- `npm run validate:config` - Validate deployment configuration
- `npm run validate:config:strict` - Strict configuration validation



### Deployment
- `npm run deploy:dev` - Deploy to development
- `npm run deploy:staging` - Deploy to staging
- `npm run deploy:prod` - Deploy to production

### Validation
- `npm run validate:dev` - Validate development deployment
- `npm run validate:staging` - Validate staging deployment
- `npm run validate:prod` - Validate production deployment

## Environment Configuration

Each environment has its own configuration file in `environments/` directory:

### Configuration Structure

```json
{
  "environment": "dev|staging|prod",
  "region": "aws-region",
  "account": "auto-detect",
  "stackName": "CloudFormation-stack-name",
  "parameters": {
    "notificationEmail": "email@example.com",
    "enableXRayTracing": "true|false",
    "logRetentionDays": "number"
  },
  "tags": {
    "Project": "S3SpecGenerator",
    "Environment": "environment-name",
    "Owner": "team-name",
    "CostCenter": "cost-center",
    "ManagedBy": "CDK"
  },
  "deployment": {
    "requireApproval": true|false,
    "enableTerminationProtection": true|false,
    "enableRollback": true|false,
    "timeoutMinutes": 30
  },
  "resources": {
    "lambdaMemorySize": {
      "readFile": 512,
      "processWithClaude": 1024,
      "writeSpecification": 256,
      "sendNotification": 256
    },
    "fileRetentionDays": 7,
    "maxFileSize": 10485760
  }
}
```

## Environment Variables

Copy the appropriate template from `env-templates/` and fill in the values:

```bash
cp deployment/env-templates/.env.dev.template .env.dev
# Edit .env.dev with your values
```

### Required Variables
- `AWS_REGION` - AWS region for deployment
- `ENVIRONMENT` - Target environment (dev/staging/prod)
- `NOTIFICATION_EMAIL` - Email for notifications

### Optional Variables
- `AWS_PROFILE` - AWS CLI profile to use
- `SLACK_WEBHOOK_URL` - Slack webhook for notifications

## Configuration Management

The system uses environment-specific JSON configuration files for all settings. No external secrets management is required for basic operation.

## Deployment Process

### Development Environment
1. Validate configuration
2. Create default secrets
3. Deploy infrastructure
4. Run functional tests

### Staging Environment
1. Validate configuration with strict checks
2. Create secrets and parameters
3. Deploy infrastructure
4. Run integration tests
5. Performance testing

### Production Environment
1. Strict configuration validation
2. Security review
3. Create production secrets
4. Deploy with manual approval
5. Comprehensive validation
6. Monitor and alert setup

## Security Considerations

### IAM Permissions
- Deployment requires CloudFormation, IAM, S3, Lambda, Step Functions permissions
- Runtime uses least-privilege IAM roles
- Secrets access is restricted to specific Lambda functions

### Encryption
- S3 buckets use server-side encryption (SSE-S3)
- Secrets Manager encrypts secrets at rest
- SSL/TLS enforced for all communications

### Network Security
- S3 buckets block public access
- Lambda functions run in AWS managed VPC
- EventBridge rules restrict event sources

## Monitoring and Alerting

### CloudWatch Metrics
- Lambda function performance and errors
- Step Functions execution metrics
- S3 bucket operations
- Custom application metrics

### Alarms
- High error rates
- Processing delays
- Dead letter queue messages
- Token usage thresholds
- System health composite alarm

### Dashboards
- Executive summary dashboard
- Operational metrics dashboard
- Security monitoring dashboard

## Troubleshooting

### Common Issues

1. **Permission Denied**
   - Check AWS CLI configuration
   - Verify IAM permissions
   - Ensure correct AWS profile

2. **Resource Already Exists**
   - Check for naming conflicts
   - Verify environment isolation
   - Clean up previous deployments

3. **Configuration Validation Fails**
   - Run `npm run validate:config:strict`
   - Check JSON syntax
   - Verify required fields

4. **Secrets Not Found**
   - Run `npm run secrets:create`
   - Check secret names and paths
   - Verify AWS region

### Getting Help

1. Check deployment logs in CloudFormation console
2. Review Lambda function logs in CloudWatch
3. Validate configuration with strict mode
4. Consult the deployment checklist
5. Check AWS service limits and quotas

## Best Practices

### Configuration Management
- Use environment-specific configuration files
- Validate configuration before deployment
- Keep secrets separate from configuration
- Use consistent naming conventions

### Security
- Rotate secrets regularly
- Use least-privilege IAM policies
- Enable termination protection for production
- Monitor access patterns

### Operations
- Deploy to staging before production
- Use infrastructure as code (CDK)
- Implement comprehensive monitoring
- Document all procedures

### Cost Optimization
- Right-size Lambda memory allocations
- Use appropriate log retention periods
- Monitor and optimize token usage
- Clean up unused resources