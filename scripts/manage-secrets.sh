#!/bin/bash

# S3 Spec Generator Secrets Management Script
# This script manages secrets and parameters for different environments

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
ACTION="list"
SECRET_NAME=""
SECRET_VALUE=""
PARAMETER_NAME=""
PARAMETER_VALUE=""

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

Manage secrets and parameters for S3 Spec Generator

ACTIONS:
    list                    List all secrets and parameters
    list-secrets           List secrets only
    list-parameters        List parameters only
    get-secret             Get a specific secret value
    set-secret             Set a secret value
    get-parameter          Get a specific parameter value
    set-parameter          Set a parameter value
    create-defaults        Create default secrets and parameters
    validate               Validate all secrets and parameters exist
    rotate-secrets         Rotate secrets (generate new values)

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION     AWS region [default: us-east-1]
    -p, --profile PROFILE   AWS profile to use
    -n, --name NAME         Secret or parameter name
    -v, --value VALUE       Secret or parameter value
    -h, --help             Show this help message

EXAMPLES:
    $0 list -e prod                                    # List all secrets/parameters for prod
    $0 get-secret -e dev -n claude-api-key            # Get Claude API key for dev
    $0 set-secret -e dev -n claude-api-key -v "sk-..." # Set Claude API key for dev
    $0 get-parameter -e prod -n max-file-size         # Get max file size parameter
    $0 create-defaults -e staging                      # Create default secrets for staging
    $0 validate -e prod                               # Validate all secrets exist for prod

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        list|list-secrets|list-parameters|get-secret|set-secret|get-parameter|set-parameter|create-defaults|validate|rotate-secrets)
            ACTION="$1"
            shift
            ;;
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
        -n|--name)
            SECRET_NAME="$2"
            PARAMETER_NAME="$2"
            shift 2
            ;;
        -v|--value)
            SECRET_VALUE="$2"
            PARAMETER_VALUE="$2"
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
    print_warning "AWS CLI will use AWS_REGION ($AWS_REGION) for operations"
    REGION="$AWS_REGION"
fi

# Define prefixes
SECRETS_PREFIX="/s3-spec-generator/$ENVIRONMENT/secrets"
PARAMETERS_PREFIX="/s3-spec-generator/$ENVIRONMENT/parameters"

print_status "Managing secrets and parameters for environment: $ENVIRONMENT"
print_status "Using region: $REGION"

# Function to list secrets
list_secrets() {
    print_status "Secrets for environment $ENVIRONMENT:"
    
    # List secrets with the prefix
    aws secretsmanager list-secrets \
        --region "$REGION" \
        --query "SecretList[?starts_with(Name, '$SECRETS_PREFIX')].{Name:Name,Description:Description,LastChanged:LastChangedDate}" \
        --output table 2>/dev/null || print_warning "No secrets found or error accessing Secrets Manager"
}

# Function to list parameters
list_parameters() {
    print_status "Parameters for environment $ENVIRONMENT:"
    
    # List parameters with the prefix
    aws ssm get-parameters-by-path \
        --path "$PARAMETERS_PREFIX" \
        --region "$REGION" \
        --query "Parameters[].{Name:Name,Value:Value,Type:Type,LastModified:LastModifiedDate}" \
        --output table 2>/dev/null || print_warning "No parameters found or error accessing SSM"
}

# Function to get a secret
get_secret() {
    if [[ -z "$SECRET_NAME" ]]; then
        print_error "Secret name is required for get-secret action"
        exit 1
    fi
    
    local full_secret_name="$SECRETS_PREFIX/$SECRET_NAME"
    
    print_status "Getting secret: $full_secret_name"
    
    SECRET_VALUE=$(aws secretsmanager get-secret-value \
        --secret-id "$full_secret_name" \
        --region "$REGION" \
        --query "SecretString" \
        --output text 2>/dev/null)
    
    if [[ $? -eq 0 ]]; then
        print_success "Secret retrieved successfully"
        echo "$SECRET_VALUE"
    else
        print_error "Failed to retrieve secret: $full_secret_name"
        exit 1
    fi
}

# Function to set a secret
set_secret() {
    if [[ -z "$SECRET_NAME" || -z "$SECRET_VALUE" ]]; then
        print_error "Secret name and value are required for set-secret action"
        exit 1
    fi
    
    local full_secret_name="$SECRETS_PREFIX/$SECRET_NAME"
    
    print_status "Setting secret: $full_secret_name"
    
    # Check if secret exists
    if aws secretsmanager describe-secret --secret-id "$full_secret_name" --region "$REGION" >/dev/null 2>&1; then
        # Update existing secret
        aws secretsmanager update-secret \
            --secret-id "$full_secret_name" \
            --secret-string "$SECRET_VALUE" \
            --region "$REGION" >/dev/null
        print_success "Secret updated successfully"
    else
        # Create new secret
        aws secretsmanager create-secret \
            --name "$full_secret_name" \
            --secret-string "$SECRET_VALUE" \
            --description "Secret for S3 Spec Generator - $ENVIRONMENT environment" \
            --region "$REGION" >/dev/null
        print_success "Secret created successfully"
    fi
}

# Function to get a parameter
get_parameter() {
    if [[ -z "$PARAMETER_NAME" ]]; then
        print_error "Parameter name is required for get-parameter action"
        exit 1
    fi
    
    local full_parameter_name="$PARAMETERS_PREFIX/$PARAMETER_NAME"
    
    print_status "Getting parameter: $full_parameter_name"
    
    PARAMETER_VALUE=$(aws ssm get-parameter \
        --name "$full_parameter_name" \
        --region "$REGION" \
        --query "Parameter.Value" \
        --output text 2>/dev/null)
    
    if [[ $? -eq 0 ]]; then
        print_success "Parameter retrieved successfully"
        echo "$PARAMETER_VALUE"
    else
        print_error "Failed to retrieve parameter: $full_parameter_name"
        exit 1
    fi
}

# Function to set a parameter
set_parameter() {
    if [[ -z "$PARAMETER_NAME" || -z "$PARAMETER_VALUE" ]]; then
        print_error "Parameter name and value are required for set-parameter action"
        exit 1
    fi
    
    local full_parameter_name="$PARAMETERS_PREFIX/$PARAMETER_NAME"
    
    print_status "Setting parameter: $full_parameter_name"
    
    aws ssm put-parameter \
        --name "$full_parameter_name" \
        --value "$PARAMETER_VALUE" \
        --type "String" \
        --description "Parameter for S3 Spec Generator - $ENVIRONMENT environment" \
        --overwrite \
        --region "$REGION" >/dev/null
    
    if [[ $? -eq 0 ]]; then
        print_success "Parameter set successfully"
    else
        print_error "Failed to set parameter: $full_parameter_name"
        exit 1
    fi
}

# Function to create default secrets and parameters
create_defaults() {
    print_status "Creating default secrets and parameters for environment: $ENVIRONMENT"
    
    # Create default secrets
    print_status "Creating default secrets..."
    
    # Claude API Key (empty by default)
    aws secretsmanager create-secret \
        --name "$SECRETS_PREFIX/claude-api-key" \
        --secret-string '{"apiKey":""}' \
        --description "Claude API key for direct API access (fallback)" \
        --region "$REGION" >/dev/null 2>&1 || print_warning "Claude API key secret may already exist"
    
    # Notification Email
    aws secretsmanager create-secret \
        --name "$SECRETS_PREFIX/notification-email" \
        --secret-string "${NOTIFICATION_EMAIL:-admin@example.com}" \
        --description "Email address for system notifications" \
        --region "$REGION" >/dev/null 2>&1 || print_warning "Notification email secret may already exist"
    
    # Slack Webhook URL
    aws secretsmanager create-secret \
        --name "$SECRETS_PREFIX/slack-webhook-url" \
        --secret-string '{"webhookUrl":""}' \
        --description "Slack webhook URL for notifications" \
        --region "$REGION" >/dev/null 2>&1 || print_warning "Slack webhook secret may already exist"
    
    # Create default parameters
    print_status "Creating default parameters..."
    
    # Environment-specific defaults
    case "$ENVIRONMENT" in
        "prod")
            MAX_FILE_SIZE="10485760"  # 10MB
            FILE_RETENTION_DAYS="30"
            LOG_RETENTION_DAYS="90"
            ENABLE_XRAY="true"
            ;;
        "staging")
            MAX_FILE_SIZE="10485760"  # 10MB
            FILE_RETENTION_DAYS="14"
            LOG_RETENTION_DAYS="14"
            ENABLE_XRAY="true"
            ;;
        *)
            MAX_FILE_SIZE="10485760"  # 10MB
            FILE_RETENTION_DAYS="7"
            LOG_RETENTION_DAYS="3"
            ENABLE_XRAY="false"
            ;;
    esac
    
    # Set parameters
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/max-file-size" --value "$MAX_FILE_SIZE" --type "String" --description "Maximum file size allowed for processing (bytes)" --overwrite --region "$REGION" >/dev/null
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/file-retention-days" --value "$FILE_RETENTION_DAYS" --type "String" --description "Number of days to retain files in input bucket" --overwrite --region "$REGION" >/dev/null
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/claude-model" --value "anthropic.claude-3-5-sonnet-20250219-v1:0" --type "String" --description "Claude model identifier for Bedrock API" --overwrite --region "$REGION" >/dev/null
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/enable-xray-tracing" --value "$ENABLE_XRAY" --type "String" --description "Enable X-Ray tracing for Lambda functions" --overwrite --region "$REGION" >/dev/null
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/log-retention-days" --value "$LOG_RETENTION_DAYS" --type "String" --description "CloudWatch log retention period in days" --overwrite --region "$REGION" >/dev/null
    aws ssm put-parameter --name "$PARAMETERS_PREFIX/lambda-timeout" --value "300" --type "String" --description "Lambda function timeout in seconds" --overwrite --region "$REGION" >/dev/null
    
    print_success "Default secrets and parameters created"
}

# Function to validate all secrets and parameters exist
validate_secrets_and_parameters() {
    print_status "Validating secrets and parameters for environment: $ENVIRONMENT"
    
    local errors=0
    
    # Required secrets
    required_secrets=(
        "claude-api-key"
        "notification-email"
        "slack-webhook-url"
    )
    
    # Required parameters
    required_parameters=(
        "max-file-size"
        "file-retention-days"
        "claude-model"
        "enable-xray-tracing"
        "log-retention-days"
        "lambda-timeout"
    )
    
    # Check secrets
    print_status "Checking required secrets..."
    for secret in "${required_secrets[@]}"; do
        if aws secretsmanager describe-secret --secret-id "$SECRETS_PREFIX/$secret" --region "$REGION" >/dev/null 2>&1; then
            print_success "Secret exists: $secret"
        else
            print_error "Missing secret: $secret"
            ((errors++))
        fi
    done
    
    # Check parameters
    print_status "Checking required parameters..."
    for param in "${required_parameters[@]}"; do
        if aws ssm get-parameter --name "$PARAMETERS_PREFIX/$param" --region "$REGION" >/dev/null 2>&1; then
            print_success "Parameter exists: $param"
        else
            print_error "Missing parameter: $param"
            ((errors++))
        fi
    done
    
    if [[ $errors -eq 0 ]]; then
        print_success "All required secrets and parameters exist"
        return 0
    else
        print_error "Validation failed with $errors missing items"
        return 1
    fi
}

# Function to rotate secrets
rotate_secrets() {
    print_status "Rotating secrets for environment: $ENVIRONMENT"
    
    # Generate new encryption key
    NEW_ENCRYPTION_KEY=$(openssl rand -hex 32)
    aws secretsmanager update-secret \
        --secret-id "$SECRETS_PREFIX/encryption-key" \
        --secret-string "{\"key\":\"$NEW_ENCRYPTION_KEY\"}" \
        --region "$REGION" >/dev/null 2>&1 || print_warning "Encryption key secret may not exist"
    
    print_success "Secrets rotated successfully"
    print_warning "Remember to restart Lambda functions to pick up new secret values"
}

# Main execution
case "$ACTION" in
    "list")
        list_secrets
        echo
        list_parameters
        ;;
    "list-secrets")
        list_secrets
        ;;
    "list-parameters")
        list_parameters
        ;;
    "get-secret")
        get_secret
        ;;
    "set-secret")
        set_secret
        ;;
    "get-parameter")
        get_parameter
        ;;
    "set-parameter")
        set_parameter
        ;;
    "create-defaults")
        create_defaults
        ;;
    "validate")
        validate_secrets_and_parameters
        ;;
    "rotate-secrets")
        rotate_secrets
        ;;
    *)
        print_error "Unknown action: $ACTION"
        show_usage
        exit 1
        ;;
esac