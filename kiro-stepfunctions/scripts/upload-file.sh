#!/bin/bash

# S3 Spec Generator File Upload Script
# This script uploads files to the input S3 bucket with proper encryption

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
REGION="eu-west-2"
PROFILE=""
FILE_PATH=""
BUCKET_NAME=""

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
Usage: $0 [OPTIONS] FILE_PATH

Upload a file to the S3 Spec Generator input bucket

ARGUMENTS:
    FILE_PATH               Path to the file to upload

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION     AWS region [default: eu-west-2]
    -p, --profile PROFILE   AWS profile to use
    -b, --bucket BUCKET     S3 bucket name (auto-detected if not provided)
    -h, --help             Show this help message

EXAMPLES:
    $0 document.pdf                           # Upload to dev environment
    $0 -e prod document.txt                   # Upload to production
    $0 -p my-profile -e staging spec.md      # Upload with specific AWS profile

SUPPORTED FILE FORMATS:
    .txt, .pdf, .doc, .docx, .md, .rtf

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
        -b|--bucket)
            BUCKET_NAME="$2"
            shift 2
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        -*)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
        *)
            if [[ -z "$FILE_PATH" ]]; then
                FILE_PATH="$1"
            else
                print_error "Multiple file paths provided. Only one file can be uploaded at a time."
                exit 1
            fi
            shift
            ;;
    esac
done

# Validate required arguments
if [[ -z "$FILE_PATH" ]]; then
    print_error "File path is required"
    show_usage
    exit 1
fi

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

# Check if file exists
if [[ ! -f "$FILE_PATH" ]]; then
    print_error "File not found: $FILE_PATH"
    exit 1
fi

# Get file extension and validate
FILE_EXTENSION="${FILE_PATH##*.}"
FILE_EXTENSION=$(echo "$FILE_EXTENSION" | tr '[:upper:]' '[:lower:]')

SUPPORTED_FORMATS=("txt" "pdf" "doc" "docx" "md" "rtf")
if [[ ! " ${SUPPORTED_FORMATS[@]} " =~ " ${FILE_EXTENSION} " ]]; then
    print_error "Unsupported file format: .$FILE_EXTENSION"
    print_error "Supported formats: ${SUPPORTED_FORMATS[*]}"
    exit 1
fi

# Auto-detect bucket name if not provided
if [[ -z "$BUCKET_NAME" ]]; then
    BUCKET_NAME="spec-generator-input-$ENVIRONMENT"
    print_status "Using auto-detected bucket name: $BUCKET_NAME"
fi

# Get file size
FILE_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null)
if [[ $FILE_SIZE -gt 10485760 ]]; then  # 10MB
    print_error "File size ($FILE_SIZE bytes) exceeds maximum allowed size (10MB)"
    exit 1
fi

# Warn about Step Functions payload limit
STEP_FUNCTIONS_LIMIT=204800  # 200KB
if [[ $FILE_SIZE -gt $STEP_FUNCTIONS_LIMIT ]]; then
    print_warning "File size ($FILE_SIZE bytes) exceeds Step Functions payload limit ($STEP_FUNCTIONS_LIMIT bytes)"
    print_warning "The file will be processed, but may fail during workflow execution"
    print_warning "Consider using smaller files for optimal performance"
fi

# Generate a unique object key with timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
FILENAME=$(basename "$FILE_PATH")
OBJECT_KEY="uploads/${TIMESTAMP}_${FILENAME}"

print_status "Upload Details:"
print_status "  File: $FILE_PATH"
print_status "  Size: $FILE_SIZE bytes"
print_status "  Bucket: $BUCKET_NAME"
print_status "  Region: $REGION"
print_status "  Object Key: $OBJECT_KEY"

# Check if AWS CLI is configured
if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
    print_error "AWS CLI is not configured or credentials are invalid"
    print_error "Please run 'aws configure' or set up your AWS credentials"
    exit 1
fi

# Check if bucket exists
if ! aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$REGION" >/dev/null 2>&1; then
    print_error "Bucket '$BUCKET_NAME' does not exist or is not accessible"
    print_error "Make sure the infrastructure is deployed and you have the correct permissions"
    exit 1
fi

# Upload file with server-side encryption
print_status "Uploading file..."

if aws s3 cp "$FILE_PATH" "s3://$BUCKET_NAME/$OBJECT_KEY" \
    --region "$REGION" \
    --server-side-encryption AES256 \
    --metadata "original-filename=$FILENAME,upload-timestamp=$TIMESTAMP,file-size=$FILE_SIZE"; then
    
    print_success "File uploaded successfully!"
    print_success "S3 URI: s3://$BUCKET_NAME/$OBJECT_KEY"
    
    # Check if EventBridge notifications are working
    print_status "The file should trigger the Step Functions workflow automatically."
    print_status "You can monitor the execution in the AWS Step Functions console."
    
    # Provide helpful next steps
    echo
    print_status "Next Steps:"
    echo "  1. Check Step Functions execution: https://console.aws.amazon.com/states/home?region=$REGION"
    echo "  2. Monitor CloudWatch logs for processing details"
    echo "  3. Check the output bucket for generated specifications"
    echo "  4. Review notifications for processing results"
    
else
    print_error "Failed to upload file"
    print_error "Common issues:"
    echo "  - Insufficient permissions (make sure the bucket policy allows your user)"
    echo "  - Bucket doesn't exist (deploy the infrastructure first)"
    echo "  - Network connectivity issues"
    echo "  - File is too large (max 10MB)"
    exit 1
fi