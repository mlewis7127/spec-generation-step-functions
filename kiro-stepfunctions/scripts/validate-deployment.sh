#!/bin/bash

# S3 Spec Generator Deployment Validation Script
# This script validates that the deployed infrastructure is working correctly

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
REGION="us-east-1"
PROFILE=""

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to show usage
show_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Validate S3 Spec Generator deployment

OPTIONS:
    -e, --environment ENV    Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION      AWS region [default: us-east-1]
    -p, --profile PROFILE    AWS profile to use
    -h, --help              Show this help message

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -p|--profile)
            PROFILE="$2"
            shift 2
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Set AWS profile if provided
if [[ -n "$PROFILE" ]]; then
    export AWS_PROFILE="$PROFILE"
fi

# Read region from environment configuration file if not explicitly provided via -r flag
CONFIG_FILE="deployment/environments/$ENVIRONMENT.json"
REGION_EXPLICITLY_SET=false

# Check if region was set via command line argument
for arg in "$@"; do
    if [[ "$arg" == "-r" ]] || [[ "$arg" == "--region" ]]; then
        REGION_EXPLICITLY_SET=true
        break
    fi
done

# If region wasn't explicitly set via -r flag, try to read from config file
if [[ -f "$CONFIG_FILE" ]] && [[ "$REGION_EXPLICITLY_SET" == false ]]; then
    CONFIG_REGION=$(jq -r '.region' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$CONFIG_REGION" != "null" && "$CONFIG_REGION" != "" ]]; then
        REGION="$CONFIG_REGION"
        print_status "Using region from configuration file: $REGION"
    fi
elif [[ "$REGION_EXPLICITLY_SET" == true ]]; then
    print_status "Using region from command line: $REGION"
fi

# Check if AWS_REGION environment variable is set and warn about potential conflicts
if [[ -n "$AWS_REGION" ]] && [[ "$AWS_REGION" != "$REGION" ]]; then
    print_warning "AWS_REGION environment variable ($AWS_REGION) differs from deployment region ($REGION)"
    print_warning "AWS CLI will use AWS_REGION ($AWS_REGION) for validation"
    REGION="$AWS_REGION"
fi

STACK_NAME="S3SpecGenerator-$ENVIRONMENT"
VALIDATION_ERRORS=0

print_status "Validating deployment for environment: $ENVIRONMENT"
print_status "Using region: $REGION"

# Function to increment error counter
increment_errors() {
    ((VALIDATION_ERRORS++))
}

# Function to validate resource exists
validate_resource() {
    local resource_type="$1"
    local resource_name="$2"
    local check_command="$3"
    
    print_status "Checking $resource_type: $resource_name"
    
    if eval "$check_command" >/dev/null 2>&1; then
        print_success "$resource_type exists and is accessible"
        return 0
    else
        print_error "$resource_type not found or not accessible"
        increment_errors
        return 1
    fi
}

# Validate CloudFormation stack exists
print_status "Validating CloudFormation stack..."
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
    STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].StackStatus' --output text)
    if [[ "$STACK_STATUS" == "CREATE_COMPLETE" || "$STACK_STATUS" == "UPDATE_COMPLETE" ]]; then
        print_success "CloudFormation stack is in good state: $STACK_STATUS"
    else
        print_error "CloudFormation stack is in unexpected state: $STACK_STATUS"
        increment_errors
    fi
else
    print_error "CloudFormation stack not found: $STACK_NAME"
    increment_errors
    exit 1
fi

# Get stack outputs
STACK_OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output json 2>/dev/null || echo "[]")

# Extract resource names from stack outputs or use naming convention
INPUT_BUCKET="spec-generator-input-$ENVIRONMENT"
OUTPUT_BUCKET="spec-generator-output-$ENVIRONMENT"
NOTIFICATION_TOPIC="spec-generator-notifications-$ENVIRONMENT"
STATE_MACHINE="spec-generator-workflow-$ENVIRONMENT"

# Validate S3 buckets
validate_resource "Input S3 Bucket" "$INPUT_BUCKET" "aws s3api head-bucket --bucket '$INPUT_BUCKET' --region '$REGION'"
validate_resource "Output S3 Bucket" "$OUTPUT_BUCKET" "aws s3api head-bucket --bucket '$OUTPUT_BUCKET' --region '$REGION'"

# Check bucket encryption
print_status "Validating S3 bucket encryption..."
for bucket in "$INPUT_BUCKET" "$OUTPUT_BUCKET"; do
    if aws s3api get-bucket-encryption --bucket "$bucket" --region "$REGION" >/dev/null 2>&1; then
        print_success "Bucket $bucket has encryption enabled"
    else
        print_error "Bucket $bucket does not have encryption enabled"
        increment_errors
    fi
done

# Check bucket public access block
print_status "Validating S3 bucket public access block..."
for bucket in "$INPUT_BUCKET" "$OUTPUT_BUCKET"; do
    PUBLIC_ACCESS_BLOCK=$(aws s3api get-public-access-block --bucket "$bucket" --region "$REGION" --query 'PublicAccessBlockConfiguration' --output json 2>/dev/null || echo "{}")
    if echo "$PUBLIC_ACCESS_BLOCK" | jq -e '.BlockPublicAcls == true and .IgnorePublicAcls == true and .BlockPublicPolicy == true and .RestrictPublicBuckets == true' >/dev/null 2>&1; then
        print_success "Bucket $bucket has proper public access block configuration"
    else
        print_error "Bucket $bucket does not have proper public access block configuration"
        increment_errors
    fi
done

# Validate SNS topic
validate_resource "SNS Topic" "$NOTIFICATION_TOPIC" "aws sns get-topic-attributes --topic-arn 'arn:aws:sns:$REGION:$(aws sts get-caller-identity --query Account --output text):$NOTIFICATION_TOPIC' --region '$REGION'"

# Validate Step Functions state machine
validate_resource "Step Functions State Machine" "$STATE_MACHINE" "aws stepfunctions describe-state-machine --state-machine-arn 'arn:aws:states:$REGION:$(aws sts get-caller-identity --query Account --output text):stateMachine:$STATE_MACHINE' --region '$REGION'"

# Validate Lambda functions
LAMBDA_FUNCTIONS=(
    "ReadFileFunction-$ENVIRONMENT"
    "ProcessWithClaudeFunction-$ENVIRONMENT"
    "WriteSpecificationFunction-$ENVIRONMENT"
    "SendNotificationFunction-$ENVIRONMENT"
)

for func in "${LAMBDA_FUNCTIONS[@]}"; do
    validate_resource "Lambda Function" "$func" "aws lambda get-function --function-name '$func' --region '$REGION'"
done

# Check Lambda function configurations
print_status "Validating Lambda function configurations..."
for func in "${LAMBDA_FUNCTIONS[@]}"; do
    # Check if X-Ray tracing is enabled
    TRACING_CONFIG=$(aws lambda get-function-configuration --function-name "$func" --region "$REGION" --query 'TracingConfig.Mode' --output text 2>/dev/null || echo "None")
    if [[ "$TRACING_CONFIG" == "Active" ]]; then
        print_success "Lambda function $func has X-Ray tracing enabled"
    else
        print_warning "Lambda function $func does not have X-Ray tracing enabled"
    fi
    
    # Check environment variables
    ENV_VARS=$(aws lambda get-function-configuration --function-name "$func" --region "$REGION" --query 'Environment.Variables' --output json 2>/dev/null || echo "{}")
    if echo "$ENV_VARS" | jq -e '.ENVIRONMENT' >/dev/null 2>&1; then
        print_success "Lambda function $func has required environment variables"
    else
        print_error "Lambda function $func is missing required environment variables"
        increment_errors
    fi
done

# Validate CloudWatch log groups
LOG_GROUPS=(
    "/aws/lambda/ReadFileFunction-$ENVIRONMENT"
    "/aws/lambda/ProcessWithClaudeFunction-$ENVIRONMENT"
    "/aws/lambda/WriteSpecificationFunction-$ENVIRONMENT"
    "/aws/lambda/SendNotificationFunction-$ENVIRONMENT"
    "/aws/stepfunctions/spec-generator-workflow-$ENVIRONMENT"
)

for log_group in "${LOG_GROUPS[@]}"; do
    validate_resource "CloudWatch Log Group" "$log_group" "aws logs describe-log-groups --log-group-name-prefix '$log_group' --region '$REGION' | jq -e '.logGroups | length > 0'"
done

# Validate IAM roles
IAM_ROLES=(
    "ReadFileFunction-Role-$ENVIRONMENT"
    "ProcessWithClaudeFunction-Role-$ENVIRONMENT"
    "WriteSpecificationFunction-Role-$ENVIRONMENT"
    "SendNotificationFunction-Role-$ENVIRONMENT"
    "StateMachine-Role-$ENVIRONMENT"
    "EventBridge-Role-$ENVIRONMENT"
)

for role in "${IAM_ROLES[@]}"; do
    validate_resource "IAM Role" "$role" "aws iam get-role --role-name '$role'"
done

# Check EventBridge rule
EVENT_RULE="s3-spec-generator-trigger-$STACK_NAME"
validate_resource "EventBridge Rule" "$EVENT_RULE" "aws events describe-rule --name '$EVENT_RULE' --region '$REGION'"

# Validate CloudWatch dashboard
DASHBOARD_NAME="S3SpecGenerator-$ENVIRONMENT"
validate_resource "CloudWatch Dashboard" "$DASHBOARD_NAME" "aws cloudwatch get-dashboard --dashboard-name '$DASHBOARD_NAME' --region '$REGION'"

# Check for CloudWatch alarms
print_status "Checking CloudWatch alarms..."
ALARM_COUNT=$(aws cloudwatch describe-alarms --alarm-name-prefix "$ENVIRONMENT-s3-spec-generator" --region "$REGION" --query 'MetricAlarms | length' --output text 2>/dev/null || echo "0")
if [[ "$ALARM_COUNT" -gt 0 ]]; then
    print_success "Found $ALARM_COUNT CloudWatch alarms configured"
else
    print_warning "No CloudWatch alarms found"
fi

# Test S3 event notification configuration
print_status "Validating S3 event notification configuration..."
NOTIFICATION_CONFIG=$(aws s3api get-bucket-notification-configuration --bucket "$INPUT_BUCKET" --region "$REGION" 2>/dev/null || echo "{}")
if echo "$NOTIFICATION_CONFIG" | jq -e '.EventBridgeConfiguration' >/dev/null 2>&1; then
    print_success "S3 bucket has EventBridge notifications enabled"
else
    print_error "S3 bucket does not have EventBridge notifications configured"
    increment_errors
fi

# Summary
print_status "Validation Summary:"
if [[ $VALIDATION_ERRORS -eq 0 ]]; then
    print_success "All validation checks passed! Deployment is healthy."
    exit 0
else
    print_error "Validation completed with $VALIDATION_ERRORS errors."
    print_error "Please review the errors above and fix any issues."
    exit 1
fi