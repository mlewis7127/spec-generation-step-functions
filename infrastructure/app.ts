#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { S3SpecGeneratorStack } from './stacks/s3-spec-generator-stack';
import { getConfig } from './config/environment';

const app = new cdk.App();

// Get environment configuration
const config = getConfig();

new S3SpecGeneratorStack(app, `S3SpecGenerator-${config.environment}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  config,
});

app.synth();