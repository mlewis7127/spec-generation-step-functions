# S3 Specification Generator

Automated document processing system that transforms uploaded files into structured specification documents using AI.

## Project Structure

```
s3-spec-generator/
├── src/
│   ├── lambda/                    # Lambda function implementations
│   │   ├── read-file/            # File reading Lambda
│   │   ├── process-with-claude/  # Claude processing Lambda
│   │   └── write-specification/  # Specification writing Lambda
│   └── shared/                   # Shared utilities and types
│       ├── types.ts             # TypeScript type definitions
│       ├── utils.ts             # Utility functions
│       └── constants.ts         # Application constants
├── infrastructure/               # AWS CDK infrastructure code
│   ├── stacks/                  # CDK stack definitions
│   │   └── s3-spec-generator-stack.ts
│   ├── config/                  # Environment configuration
│   │   └── environment.ts
│   └── app.ts                   # CDK application entry point
├── test/                        # Test files
│   └── setup.ts                 # Jest test setup
├── .kiro/specs/                 # Kiro specification documents
│   └── s3-spec-generator/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
├── package.json                 # Node.js dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── cdk.json                    # CDK configuration
├── jest.config.js              # Jest testing configuration
├── .env.example                # Environment variables template
└── .gitignore                  # Git ignore rules
```

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment settings:
   ```bash
   # Update the environment configuration file for your target environment
   # Edit deployment/environments/dev.json for development
   # Edit deployment/environments/staging.json for staging  
   # Edit deployment/environments/prod.json for production
   ```

3. Configure AWS credentials and update the environment JSON file with your settings (especially `notificationEmail`)

4. Build the project (compiles TypeScript and prepares Lambda functions):
   ```bash
   npm run build
   ```

5. Deploy infrastructure:
   ```bash
   # Deploy to development environment
   npm run deploy:dev
   
   # Or deploy to other environments
   npm run deploy:staging
   npm run deploy:prod
   ```

## Development

- `npm run build` - Compile TypeScript
- `npm run watch` - Watch for changes and recompile
- `npm test` - Run tests
- `npm run cdk synth` - Synthesize CloudFormation template
- `npm run cdk diff` - Show differences between deployed and local stack

## Architecture

The system uses an event-driven architecture with AWS Step Functions orchestrating the processing pipeline:

1. Files uploaded to S3 input bucket trigger Step Functions execution
2. ReadFileFunction reads and validates the uploaded file
3. ProcessWithClaudeFunction sends content to Claude LLM via Bedrock
4. WriteSpecificationFunction saves generated specifications to output bucket
5. SNS notifications inform users of processing status

## Requirements

- Node.js 18+
- AWS CLI configured
- AWS CDK CLI installed
- TypeScript

## Configuration

Environment-specific configuration is managed through JSON files in `deployment/environments/`:

- `dev.json` - Development environment settings
- `staging.json` - Staging environment settings  
- `prod.json` - Production environment settings

Key configuration parameters:
- `notificationEmail` - Email address for deployment notifications
- `region` - AWS region for deployment
- `parameters.enableXRayTracing` - Enable AWS X-Ray tracing
- `resources.lambdaMemorySize` - Memory allocation for Lambda functions

See `.env.example` for additional environment variables that can be used during development.