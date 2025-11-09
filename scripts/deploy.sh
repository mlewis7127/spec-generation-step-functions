#!/bin/bash

# S3 Spec Generator Deployment Script
# This script handles deployment of the S3 Specification Generator infrastructure
# using AWS CDK with environment-specific configuration management

set -e  # Exit on any error

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
SKIP_BOOTSTRAP=false
DRY_RUN=false
DESTROY=false
DIFF_ONLY=false

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

Deploy S3 Spec Generator infrastructure using AWS CDK

OPTIONS:
    -e, --environment ENV    Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION      AWS region [default: us-east-1]
    -p, --profile PROFILE    AWS profile to use
    -b, --skip-bootstrap     Skip CDK bootstrap
    -d, --dry-run           Show what would be deployed without making changes
    -D, --destroy           Destroy the stack instead of deploying
    --diff                  Show differences only, don't deploy
    -h, --help              Show this help message

EXAMPLES:
    $0 -e dev                           # Deploy to dev environment
    $0 -e prod -r us-west-2 -p prod    # Deploy to prod in us-west-2 with prod profile
    $0 -e staging --dry-run             # Show what would be deployed to staging
    $0 -e dev --destroy                 # Destroy dev environment
    $0 -e prod --diff                   # Show differences for prod environment

ENVIRONMENT VARIABLES:
    NOTIFICATION_EMAIL      Email address for notifications
    CDK_DEFAULT_ACCOUNT     AWS account ID (auto-detected if not set)
    CDK_DEFAULT_REGION      AWS region (overridden by -r flag)

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
        -b|--skip-bootstrap)
            SKIP_BOOTSTRAP=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -D|--destroy)
            DESTROY=true
            shift
            ;;
        --diff)
            DIFF_ONLY=true
            shift
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

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    print_error "Invalid environment: $ENVIRONMENT. Must be one of: dev, staging, prod"
    exit 1
fi

# Set AWS profile if provided
if [[ -n "$PROFILE" ]]; then
    export AWS_PROFILE="$PROFILE"
    print_status "Using AWS profile: $PROFILE"
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
    print_warning "CDK will use AWS_REGION ($AWS_REGION) for deployment"
    REGION="$AWS_REGION"
fi

# Set environment variables
export ENVIRONMENT="$ENVIRONMENT"
export CDK_DEFAULT_REGION="$REGION"

# Load notification email from config file if available
if [[ -f "$CONFIG_FILE" ]]; then
    NOTIFICATION_EMAIL=$(jq -r '.parameters.notificationEmail // empty' "$CONFIG_FILE" 2>/dev/null)
    if [[ -n "$NOTIFICATION_EMAIL" && "$NOTIFICATION_EMAIL" != "null" ]]; then
        export NOTIFICATION_EMAIL="$NOTIFICATION_EMAIL"
    fi
fi

print_status "Deployment Configuration:"
print_status "  Environment: $ENVIRONMENT"
print_status "  Region: $REGION"
print_status "  AWS Profile: ${PROFILE:-default}"
print_status "  Notification Email: ${NOTIFICATION_EMAIL:-not set}"

# Check if AWS CLI is configured
if ! aws sts get-caller-identity >/dev/null 2>&1; then
    print_error "AWS CLI is not configured or credentials are invalid"
    print_error "Please run 'aws configure' or set up your AWS credentials"
    exit 1
fi

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID"
print_status "  Account ID: $ACCOUNT_ID"

# Check if Node.js and npm are installed
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js 18 or later."
    exit 1
fi

if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install npm."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
    print_error "Node.js version 18 or later is required. Current version: $(node --version)"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [[ ! -d "node_modules" ]]; then
    print_status "Installing dependencies..."
    npm install
fi

# Build TypeScript
print_status "Building TypeScript..."
npm run build

# CDK bootstrap if not skipped
if [[ "$SKIP_BOOTSTRAP" == false ]]; then
    print_status "Bootstrapping CDK (if needed)..."
    npx cdk bootstrap aws://$ACCOUNT_ID/$REGION
fi

# Stack name
STACK_NAME="S3SpecGenerator-$ENVIRONMENT"

if [[ "$DESTROY" == true ]]; then
    print_warning "This will destroy the $ENVIRONMENT environment!"
    read -p "Are you sure you want to continue? (yes/no): " -r
    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        print_status "Deployment cancelled."
        exit 0
    fi
    
    print_status "Destroying stack: $STACK_NAME"
    npx cdk destroy "$STACK_NAME" --force
    print_success "Stack destroyed successfully!"
    exit 0
fi

if [[ "$DIFF_ONLY" == true ]]; then
    print_status "Showing differences for stack: $STACK_NAME"
    npx cdk diff "$STACK_NAME"
    exit 0
fi

if [[ "$DRY_RUN" == true ]]; then
    print_status "Dry run - showing what would be deployed:"
    npx cdk synth "$STACK_NAME"
    exit 0
fi

# Deploy the stack
print_status "Deploying stack: $STACK_NAME"
npx cdk deploy "$STACK_NAME" --require-approval never

print_success "Deployment completed successfully!"

# Output important information
print_status "Stack Outputs:"
aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey!=`null`].[OutputKey,OutputValue]' \
    --output table 2>/dev/null || print_warning "Could not retrieve stack outputs"

print_status "Deployment Summary:"
print_status "  Environment: $ENVIRONMENT"
print_status "  Stack Name: $STACK_NAME"
print_status "  Region: $REGION"
print_status "  Account: $ACCOUNT_ID"

if [[ "$ENVIRONMENT" == "prod" ]]; then
    print_warning "Production deployment completed. Please verify all services are working correctly."
fi