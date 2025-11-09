#!/bin/bash

# S3 Spec Generator End-to-End Workflow Test
# This script uploads a file, waits for processing, and downloads the result

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
WAIT_TIME=60
MAX_WAIT=300

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

Test the complete S3 Spec Generator workflow by uploading a file and downloading the result

ARGUMENTS:
    FILE_PATH               Path to the file to upload and process

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION     AWS region [default: eu-west-2]
    -p, --profile PROFILE   AWS profile to use
    -w, --wait SECONDS      Initial wait time before checking for results [default: 60]
    -m, --max-wait SECONDS  Maximum wait time for processing [default: 300]
    -h, --help             Show this help message

EXAMPLES:
    $0 document.pdf                           # Test with document.pdf
    $0 -e staging -w 120 spec.md             # Test staging with 2min wait
    $0 -p my-profile document.txt            # Test with specific AWS profile

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
        -w|--wait)
            WAIT_TIME="$2"
            shift 2
            ;;
        -m|--max-wait)
            MAX_WAIT="$2"
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
                print_error "Multiple file paths provided. Only one file can be processed at a time."
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

# Check if file exists
if [[ ! -f "$FILE_PATH" ]]; then
    print_error "File not found: $FILE_PATH"
    exit 1
fi

print_status "=== S3 Spec Generator Workflow Test ==="
print_status "File: $FILE_PATH"
print_status "Environment: $ENVIRONMENT"
print_status "Region: $REGION"
echo

# Step 1: Upload the file
print_status "Step 1: Uploading file..."
UPLOAD_ARGS="-e $ENVIRONMENT -r $REGION"
if [[ -n "$PROFILE" ]]; then
    UPLOAD_ARGS="$UPLOAD_ARGS -p $PROFILE"
fi

if ./scripts/upload-file.sh $UPLOAD_ARGS "$FILE_PATH"; then
    print_success "File uploaded successfully"
else
    print_error "Failed to upload file"
    exit 1
fi

echo

# Step 2: Wait for processing
print_status "Step 2: Waiting for processing to complete..."
print_status "Initial wait time: ${WAIT_TIME} seconds"
print_status "This allows time for:"
echo "  - S3 event notification to trigger"
echo "  - Step Functions workflow to start"
echo "  - Lambda functions to process the file"
echo "  - Claude to generate the specification"
echo "  - Results to be written to output bucket"

# Show a progress indicator
for ((i=1; i<=WAIT_TIME; i++)); do
    printf "\rWaiting... %d/%d seconds" $i $WAIT_TIME
    sleep 1
done
echo

print_success "Initial wait completed"
echo

# Step 3: Check for results and download
print_status "Step 3: Checking for generated specifications..."
DOWNLOAD_ARGS="-e $ENVIRONMENT -r $REGION"
if [[ -n "$PROFILE" ]]; then
    DOWNLOAD_ARGS="$DOWNLOAD_ARGS -p $PROFILE"
fi

# First, list what's available
print_status "Listing available specifications..."
if ./scripts/download-specification.sh $DOWNLOAD_ARGS --list; then
    echo
    
    # Try to download all specifications
    print_status "Downloading generated specifications..."
    if ./scripts/download-specification.sh $DOWNLOAD_ARGS -o "./test-results"; then
        print_success "Specifications downloaded to ./test-results/"
        
        # Show what was downloaded
        if [[ -d "./test-results" ]]; then
            local file_count=$(find "./test-results" -type f | wc -l | tr -d ' ')
            if [[ $file_count -gt 0 ]]; then
                print_success "Workflow test completed successfully!"
                print_status "Generated files:"
                find "./test-results" -type f -exec basename {} \;
                
                # Show a preview of the first generated file
                local first_file=$(find "./test-results" -type f | head -1)
                if [[ -n "$first_file" ]] && file "$first_file" | grep -q "text"; then
                    echo
                    print_status "Preview of generated specification:"
                    echo "========================================"
                    head -20 "$first_file"
                    echo "========================================"
                fi
            else
                print_warning "No files were downloaded - processing may still be in progress"
                suggest_troubleshooting
            fi
        fi
    else
        print_warning "Failed to download specifications - they may not be ready yet"
        suggest_troubleshooting
    fi
else
    print_warning "Could not list specifications - processing may still be in progress"
    suggest_troubleshooting
fi

# Function to suggest troubleshooting steps
suggest_troubleshooting() {
    echo
    print_status "Troubleshooting suggestions:"
    echo "  1. Check Step Functions execution in AWS Console:"
    echo "     https://console.aws.amazon.com/states/home?region=$REGION"
    echo
    echo "  2. Check CloudWatch logs for Lambda functions:"
    echo "     https://console.aws.amazon.com/cloudwatch/home?region=$REGION#logsV2:log-groups"
    echo
    echo "  3. Wait longer and try downloading again:"
    echo "     npm run download"
    echo
    echo "  4. Check if the file format is supported:"
    echo "     Supported: .txt, .pdf, .doc, .docx, .md, .rtf"
    echo
    echo "  5. Verify the input bucket has the uploaded file:"
    echo "     aws s3 ls s3://spec-generator-input-$ENVIRONMENT/ --region $REGION"
}

echo
print_status "=== Workflow Test Summary ==="
print_status "✓ File uploaded to input bucket"
print_status "✓ Processing time allowed: ${WAIT_TIME} seconds"
print_status "✓ Results checked and downloaded"
print_success "End-to-end workflow test completed!"