#!/bin/bash

# S3 Spec Generator Configuration Validation Script
# This script validates deployment configuration before deployment

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
CONFIG_FILE=""
STRICT_MODE=false

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

Validate S3 Spec Generator configuration

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -f, --file FILE        Configuration file to validate
    -s, --strict           Enable strict validation mode
    -h, --help             Show this help message

EXAMPLES:
    $0 -e dev                              # Validate dev environment
    $0 -e prod --strict                    # Validate prod with strict checks
    $0 -f deployment/environments/dev.json # Validate specific config file

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -f|--file)
            CONFIG_FILE="$2"
            shift 2
            ;;
        -s|--strict)
            STRICT_MODE=true
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

# Set config file if not provided
if [[ -z "$CONFIG_FILE" ]]; then
    CONFIG_FILE="deployment/environments/$ENVIRONMENT.json"
fi

print_status "Validating configuration for environment: $ENVIRONMENT"
print_status "Configuration file: $CONFIG_FILE"

VALIDATION_ERRORS=0

# Function to increment error counter
increment_errors() {
    ((VALIDATION_ERRORS++))
}

# Function to validate file exists
validate_file_exists() {
    if [[ ! -f "$CONFIG_FILE" ]]; then
        print_error "Configuration file not found: $CONFIG_FILE"
        increment_errors
        return 1
    fi
    print_success "Configuration file exists"
    return 0
}

# Function to validate JSON syntax
validate_json_syntax() {
    if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
        print_error "Invalid JSON syntax in configuration file"
        increment_errors
        return 1
    fi
    print_success "JSON syntax is valid"
    return 0
}

# Function to validate required fields
validate_required_fields() {
    print_status "Validating required fields..."
    
    local required_fields=(
        ".environment"
        ".region"
        ".stackName"
        ".tags.Project"
        ".tags.Environment"
        ".tags.Owner"
        ".deployment.requireApproval"
        ".deployment.enableTerminationProtection"
        ".resources.lambdaMemorySize.readFile"
        ".resources.lambdaMemorySize.processWithClaude"
        ".resources.lambdaMemorySize.writeSpecification"
        ".resources.lambdaMemorySize.sendNotification"
        ".resources.fileRetentionDays"
        ".resources.maxFileSize"
    )
    
    for field in "${required_fields[@]}"; do
        # Check if field exists by testing if it's not null
        local field_value=$(jq -r "$field" "$CONFIG_FILE" 2>/dev/null)
        if [[ "$field_value" == "null" ]]; then
            print_error "Missing required field: $field"
            increment_errors
        fi
    done
    
    if [[ $VALIDATION_ERRORS -eq 0 ]]; then
        print_success "All required fields present"
    fi
}

# Function to validate environment consistency
validate_environment_consistency() {
    print_status "Validating environment consistency..."
    
    local config_env=$(jq -r '.environment' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$config_env" != "$ENVIRONMENT" ]]; then
        print_error "Environment mismatch: config has '$config_env', expected '$ENVIRONMENT'"
        increment_errors
    else
        print_success "Environment consistency validated"
    fi
    
    # Check stack name contains environment
    local stack_name=$(jq -r '.stackName' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$stack_name" != *"$ENVIRONMENT"* ]]; then
        print_warning "Stack name '$stack_name' does not contain environment '$ENVIRONMENT'"
    fi
    
    # Check tags environment
    local tag_env=$(jq -r '.tags.Environment' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$tag_env" != "$ENVIRONMENT" ]]; then
        print_error "Tag environment mismatch: tag has '$tag_env', expected '$ENVIRONMENT'"
        increment_errors
    fi
}

# Function to validate Lambda memory sizes
validate_lambda_memory() {
    print_status "Validating Lambda memory configurations..."
    
    local memory_fields=(
        "readFile"
        "processWithClaude"
        "writeSpecification"
        "sendNotification"
    )
    
    for field in "${memory_fields[@]}"; do
        local memory_size=$(jq -r ".resources.lambdaMemorySize.$field" "$CONFIG_FILE" 2>/dev/null)
        
        if [[ "$memory_size" == "null" ]]; then
            print_error "Missing memory size for $field"
            increment_errors
            continue
        fi
        
        # Check memory size range (128-10240 MB)
        if [[ $memory_size -lt 128 || $memory_size -gt 10240 ]]; then
            print_error "Invalid memory size for $field: $memory_size (must be 128-10240 MB)"
            increment_errors
        fi
        
        # Check memory size is multiple of 64
        if [[ $((memory_size % 64)) -ne 0 ]]; then
            print_error "Memory size for $field must be multiple of 64 MB: $memory_size"
            increment_errors
        fi
    done
    
    if [[ $VALIDATION_ERRORS -eq 0 ]]; then
        print_success "Lambda memory configurations are valid"
    fi
}

# Function to validate resource limits
validate_resource_limits() {
    print_status "Validating resource limits..."
    
    # File retention days (1-365)
    local retention_days=$(jq -r '.resources.fileRetentionDays' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$retention_days" != "null" ]]; then
        if [[ $retention_days -lt 1 || $retention_days -gt 365 ]]; then
            print_error "Invalid file retention days: $retention_days (must be 1-365)"
            increment_errors
        fi
    fi
    
    # Max file size (1KB to 50MB)
    local max_file_size=$(jq -r '.resources.maxFileSize' "$CONFIG_FILE" 2>/dev/null)
    if [[ "$max_file_size" != "null" ]]; then
        if [[ $max_file_size -lt 1024 || $max_file_size -gt 52428800 ]]; then
            print_error "Invalid max file size: $max_file_size (must be 1KB-50MB)"
            increment_errors
        fi
    fi
    
    if [[ $VALIDATION_ERRORS -eq 0 ]]; then
        print_success "Resource limits are valid"
    fi
}

# Function to validate environment-specific requirements
validate_environment_requirements() {
    print_status "Validating environment-specific requirements..."
    
    case "$ENVIRONMENT" in
        "prod")
            # Production should have termination protection
            local termination_protection=$(jq -r '.deployment.enableTerminationProtection' "$CONFIG_FILE" 2>/dev/null)
            if [[ "$termination_protection" != "true" ]]; then
                if [[ "$STRICT_MODE" == true ]]; then
                    print_error "Production environment should have termination protection enabled"
                    increment_errors
                else
                    print_warning "Production environment should have termination protection enabled"
                fi
            fi
            
            # Production should require approval
            local require_approval=$(jq -r '.deployment.requireApproval' "$CONFIG_FILE" 2>/dev/null)
            if [[ "$require_approval" != "true" ]]; then
                if [[ "$STRICT_MODE" == true ]]; then
                    print_error "Production environment should require approval for deployments"
                    increment_errors
                else
                    print_warning "Production environment should require approval for deployments"
                fi
            fi
            
            # Production should have backup enabled
            local backup=$(jq -r '.tags.Backup' "$CONFIG_FILE" 2>/dev/null)
            if [[ "$backup" != "required" && "$backup" != "enabled" ]]; then
                print_warning "Production environment should have backup enabled"
            fi
            ;;
        "dev")
            # Dev should not have termination protection
            local termination_protection=$(jq -r '.deployment.enableTerminationProtection' "$CONFIG_FILE" 2>/dev/null)
            if [[ "$termination_protection" == "true" ]]; then
                print_warning "Development environment typically should not have termination protection"
            fi
            ;;
    esac
}

# Function to validate AWS resource naming
validate_aws_naming() {
    print_status "Validating AWS resource naming conventions..."
    
    # Stack name validation (CloudFormation naming rules)
    local stack_name=$(jq -r '.stackName' "$CONFIG_FILE" 2>/dev/null)
    if [[ ! "$stack_name" =~ ^[a-zA-Z][a-zA-Z0-9-]*$ ]]; then
        print_error "Invalid stack name format: $stack_name (must start with letter, contain only alphanumeric and hyphens)"
        increment_errors
    fi
    
    if [[ ${#stack_name} -gt 128 ]]; then
        print_error "Stack name too long: ${#stack_name} characters (max 128)"
        increment_errors
    fi
    
    # Validate tag values
    local tag_keys=$(jq -r '.tags | keys[]' "$CONFIG_FILE" 2>/dev/null)
    while IFS= read -r key; do
        local value=$(jq -r ".tags.\"$key\"" "$CONFIG_FILE" 2>/dev/null)
        
        # Tag key validation
        if [[ ${#key} -gt 128 ]]; then
            print_error "Tag key too long: $key (max 128 characters)"
            increment_errors
        fi
        
        # Tag value validation
        if [[ ${#value} -gt 256 ]]; then
            print_error "Tag value too long for key '$key': $value (max 256 characters)"
            increment_errors
        fi
    done <<< "$tag_keys"
    
    if [[ $VALIDATION_ERRORS -eq 0 ]]; then
        print_success "AWS resource naming conventions are valid"
    fi
}

# Function to validate security settings
validate_security_settings() {
    print_status "Validating security settings..."
    
    # Check for notification email in production
    if [[ "$ENVIRONMENT" == "prod" ]]; then
        local notification_email=$(jq -r '.parameters.notificationEmail // empty' "$CONFIG_FILE" 2>/dev/null)
        if [[ -z "$notification_email" ]]; then
            print_warning "Production environment should have notification email configured"
        fi
    fi
    
    # Check X-Ray tracing for non-dev environments
    if [[ "$ENVIRONMENT" != "dev" ]]; then
        local xray_tracing=$(jq -r '.parameters.enableXRayTracing // "false"' "$CONFIG_FILE" 2>/dev/null)
        if [[ "$xray_tracing" != "true" ]]; then
            print_warning "Non-development environments should have X-Ray tracing enabled"
        fi
    fi
    
    print_success "Security settings validated"
}

# Main validation execution
print_status "Starting configuration validation..."

# Run all validations
validate_file_exists || exit 1
validate_json_syntax || exit 1
validate_required_fields
validate_environment_consistency
validate_lambda_memory
validate_resource_limits
validate_environment_requirements
validate_aws_naming
validate_security_settings

# Summary
print_status "Validation Summary:"
if [[ $VALIDATION_ERRORS -eq 0 ]]; then
    print_success "Configuration validation passed! No errors found."
    
    # Show configuration summary
    print_status "Configuration Summary:"
    echo "  Environment: $(jq -r '.environment' "$CONFIG_FILE")"
    echo "  Region: $(jq -r '.region' "$CONFIG_FILE")"
    echo "  Stack Name: $(jq -r '.stackName' "$CONFIG_FILE")"
    echo "  Termination Protection: $(jq -r '.deployment.enableTerminationProtection' "$CONFIG_FILE")"
    echo "  Require Approval: $(jq -r '.deployment.requireApproval' "$CONFIG_FILE")"
    
    exit 0
else
    print_error "Configuration validation failed with $VALIDATION_ERRORS errors."
    print_error "Please fix the errors above before deploying."
    exit 1
fi