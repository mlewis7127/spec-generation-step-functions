#!/bin/bash

# S3 Spec Generator Configuration Management Script
# This script manages environment-specific configuration and resource naming

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
ACTION="show"
CONFIG_FILE=""

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
Usage: $0 [OPTIONS] ACTION

Manage S3 Spec Generator configuration

ACTIONS:
    show                    Show current configuration for environment
    validate               Validate configuration for environment
    generate-tags          Generate resource tags for environment
    export-env             Export environment variables for deployment
    create-config          Create configuration file template

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -f, --file FILE        Configuration file path
    -h, --help             Show this help message

EXAMPLES:
    $0 show -e prod                    # Show production configuration
    $0 validate -e staging             # Validate staging configuration
    $0 generate-tags -e dev            # Generate tags for dev environment
    $0 export-env -e prod              # Export prod environment variables
    $0 create-config -f config.json    # Create configuration template

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        show|validate|generate-tags|export-env|create-config)
            ACTION="$1"
            shift
            ;;
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -f|--file)
            CONFIG_FILE="$2"
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

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    print_error "Invalid environment: $ENVIRONMENT. Must be one of: dev, staging, prod"
    exit 1
fi

# Function to get configuration values
get_config() {
    local env="$1"
    
    case "$env" in
        "dev")
            cat << EOF
{
  "environment": "dev",
  "inputBucketName": "spec-generator-input-dev",
  "outputBucketName": "spec-generator-output-dev",
  "notificationTopicName": "spec-generator-notifications-dev",
  "stepFunctionName": "spec-generator-workflow-dev",
  "lambdaTimeout": 300,
  "lambdaMemorySize": {
    "readFile": 512,
    "processWithClaude": 1024,
    "writeSpecification": 256,
    "sendNotification": 256
  },
  "fileRetentionDays": 7,
  "maxFileSize": 10485760,
  "claudeModel": "anthropic.claude-3-5-sonnet-20250219-v1:0",
  "tags": {
    "Project": "S3SpecGenerator",
    "Environment": "dev",
    "Owner": "DevTeam",
    "CostCenter": "Engineering",
    "Backup": "false"
  }
}
EOF
            ;;
        "staging")
            cat << EOF
{
  "environment": "staging",
  "inputBucketName": "spec-generator-input-staging",
  "outputBucketName": "spec-generator-output-staging",
  "notificationTopicName": "spec-generator-notifications-staging",
  "stepFunctionName": "spec-generator-workflow-staging",
  "lambdaTimeout": 300,
  "lambdaMemorySize": {
    "readFile": 768,
    "processWithClaude": 1536,
    "writeSpecification": 384,
    "sendNotification": 384
  },
  "fileRetentionDays": 14,
  "maxFileSize": 10485760,
  "claudeModel": "anthropic.claude-3-5-sonnet-20250219-v1:0",
  "tags": {
    "Project": "S3SpecGenerator",
    "Environment": "staging",
    "Owner": "DevTeam",
    "CostCenter": "Engineering",
    "Backup": "true"
  }
}
EOF
            ;;
        "prod")
            cat << EOF
{
  "environment": "prod",
  "inputBucketName": "spec-generator-input-prod",
  "outputBucketName": "spec-generator-output-prod",
  "notificationTopicName": "spec-generator-notifications-prod",
  "stepFunctionName": "spec-generator-workflow-prod",
  "lambdaTimeout": 300,
  "lambdaMemorySize": {
    "readFile": 1024,
    "processWithClaude": 2048,
    "writeSpecification": 512,
    "sendNotification": 512
  },
  "fileRetentionDays": 30,
  "maxFileSize": 10485760,
  "claudeModel": "anthropic.claude-3-5-sonnet-20250219-v1:0",
  "tags": {
    "Project": "S3SpecGenerator",
    "Environment": "prod",
    "Owner": "ProductionTeam",
    "CostCenter": "Operations",
    "Backup": "true",
    "Compliance": "required"
  }
}
EOF
            ;;
    esac
}

# Function to validate configuration
validate_config() {
    local config="$1"
    local errors=0
    
    print_status "Validating configuration for environment: $ENVIRONMENT"
    
    # Check required fields
    required_fields=("environment" "inputBucketName" "outputBucketName" "notificationTopicName" "stepFunctionName")
    
    for field in "${required_fields[@]}"; do
        if ! echo "$config" | jq -e ".$field" >/dev/null 2>&1; then
            print_error "Missing required field: $field"
            ((errors++))
        fi
    done
    
    # Validate bucket names (S3 naming rules)
    for bucket_field in "inputBucketName" "outputBucketName"; do
        bucket_name=$(echo "$config" | jq -r ".$bucket_field")
        if [[ ${#bucket_name} -lt 3 || ${#bucket_name} -gt 63 ]]; then
            print_error "Invalid bucket name length for $bucket_field: $bucket_name"
            ((errors++))
        fi
        
        if [[ ! "$bucket_name" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]]; then
            print_error "Invalid bucket name format for $bucket_field: $bucket_name"
            ((errors++))
        fi
    done
    
    # Validate memory sizes
    memory_sizes=$(echo "$config" | jq -r '.lambdaMemorySize | to_entries[] | "\(.key):\(.value)"')
    while IFS=: read -r func_name memory_size; do
        if [[ $memory_size -lt 128 || $memory_size -gt 10240 ]]; then
            print_error "Invalid memory size for $func_name: $memory_size (must be between 128-10240 MB)"
            ((errors++))
        fi
        
        # Memory must be multiple of 64
        if [[ $((memory_size % 64)) -ne 0 ]]; then
            print_error "Memory size for $func_name must be multiple of 64 MB: $memory_size"
            ((errors++))
        fi
    done <<< "$memory_sizes"
    
    # Validate timeout
    timeout=$(echo "$config" | jq -r '.lambdaTimeout')
    if [[ $timeout -lt 1 || $timeout -gt 900 ]]; then
        print_error "Invalid Lambda timeout: $timeout (must be between 1-900 seconds)"
        ((errors++))
    fi
    
    # Validate file retention days
    retention=$(echo "$config" | jq -r '.fileRetentionDays')
    if [[ $retention -lt 1 || $retention -gt 365 ]]; then
        print_error "Invalid file retention days: $retention (must be between 1-365 days)"
        ((errors++))
    fi
    
    # Validate max file size
    max_size=$(echo "$config" | jq -r '.maxFileSize')
    if [[ $max_size -lt 1024 || $max_size -gt 52428800 ]]; then  # 1KB to 50MB
        print_error "Invalid max file size: $max_size (must be between 1KB-50MB)"
        ((errors++))
    fi
    
    if [[ $errors -eq 0 ]]; then
        print_success "Configuration validation passed"
        return 0
    else
        print_error "Configuration validation failed with $errors errors"
        return 1
    fi
}

# Function to generate resource tags
generate_tags() {
    local config="$1"
    
    print_status "Resource tags for environment: $ENVIRONMENT"
    echo "$config" | jq -r '.tags | to_entries[] | "  \(.key)=\(.value)"'
}

# Function to export environment variables
export_env_vars() {
    local config="$1"
    
    print_status "Environment variables for deployment:"
    cat << EOF
export ENVIRONMENT="$ENVIRONMENT"
export INPUT_BUCKET_NAME="$(echo "$config" | jq -r '.inputBucketName')"
export OUTPUT_BUCKET_NAME="$(echo "$config" | jq -r '.outputBucketName')"
export NOTIFICATION_TOPIC_NAME="$(echo "$config" | jq -r '.notificationTopicName')"
export STEP_FUNCTION_NAME="$(echo "$config" | jq -r '.stepFunctionName')"
export LAMBDA_TIMEOUT="$(echo "$config" | jq -r '.lambdaTimeout')"
export FILE_RETENTION_DAYS="$(echo "$config" | jq -r '.fileRetentionDays')"
export MAX_FILE_SIZE="$(echo "$config" | jq -r '.maxFileSize')"
export CLAUDE_MODEL="$(echo "$config" | jq -r '.claudeModel')"

# Lambda memory sizes
export READ_FILE_MEMORY="$(echo "$config" | jq -r '.lambdaMemorySize.readFile')"
export PROCESS_CLAUDE_MEMORY="$(echo "$config" | jq -r '.lambdaMemorySize.processWithClaude')"
export WRITE_SPEC_MEMORY="$(echo "$config" | jq -r '.lambdaMemorySize.writeSpecification')"
export SEND_NOTIFICATION_MEMORY="$(echo "$config" | jq -r '.lambdaMemorySize.sendNotification')"
EOF
}

# Function to create configuration template
create_config_template() {
    local file="$1"
    
    if [[ -z "$file" ]]; then
        print_error "Configuration file path is required for create-config action"
        exit 1
    fi
    
    print_status "Creating configuration template: $file"
    
    cat > "$file" << 'EOF'
{
  "environment": "ENVIRONMENT_NAME",
  "inputBucketName": "spec-generator-input-ENVIRONMENT_NAME",
  "outputBucketName": "spec-generator-output-ENVIRONMENT_NAME",
  "notificationTopicName": "spec-generator-notifications-ENVIRONMENT_NAME",
  "stepFunctionName": "spec-generator-workflow-ENVIRONMENT_NAME",
  "lambdaTimeout": 300,
  "lambdaMemorySize": {
    "readFile": 512,
    "processWithClaude": 1024,
    "writeSpecification": 256,
    "sendNotification": 256
  },
  "fileRetentionDays": 7,
  "maxFileSize": 10485760,
  "claudeModel": "anthropic.claude-3-5-sonnet-20250219-v1:0",
  "notificationEmail": "NOTIFICATION_EMAIL",
  "tags": {
    "Project": "S3SpecGenerator",
    "Environment": "ENVIRONMENT_NAME",
    "Owner": "OWNER_NAME",
    "CostCenter": "COST_CENTER",
    "Backup": "true"
  }
}
EOF
    
    print_success "Configuration template created: $file"
    print_status "Please replace placeholder values (ENVIRONMENT_NAME, etc.) with actual values"
}

# Main execution
case "$ACTION" in
    "show")
        print_status "Configuration for environment: $ENVIRONMENT"
        get_config "$ENVIRONMENT" | jq .
        ;;
    "validate")
        config=$(get_config "$ENVIRONMENT")
        validate_config "$config"
        ;;
    "generate-tags")
        config=$(get_config "$ENVIRONMENT")
        generate_tags "$config"
        ;;
    "export-env")
        config=$(get_config "$ENVIRONMENT")
        export_env_vars "$config"
        ;;
    "create-config")
        create_config_template "$CONFIG_FILE"
        ;;
    *)
        print_error "Unknown action: $ACTION"
        show_usage
        exit 1
        ;;
esac