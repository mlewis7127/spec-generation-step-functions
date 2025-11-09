#!/bin/bash

# S3 Spec Generator Download Script
# This script downloads generated specifications from the output S3 bucket

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
OUTPUT_DIR="./downloads"
BUCKET_NAME=""
OBJECT_KEY=""
LIST_ONLY=false

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
Usage: $0 [OPTIONS] [OBJECT_KEY]

Download generated specifications from the S3 Spec Generator output bucket

ARGUMENTS:
    OBJECT_KEY              Specific object key to download (optional)

OPTIONS:
    -e, --environment ENV   Target environment (dev, staging, prod) [default: dev]
    -r, --region REGION     AWS region [default: eu-west-2]
    -p, --profile PROFILE   AWS profile to use
    -b, --bucket BUCKET     S3 bucket name (auto-detected if not provided)
    -o, --output DIR        Output directory for downloads [default: ./downloads]
    -l, --list             List available specifications without downloading
    -h, --help             Show this help message

EXAMPLES:
    $0                                        # List all specifications in dev
    $0 -l                                     # List all specifications
    $0 specifications/2024/01/15/spec.md     # Download specific file
    $0 -e prod -o ./prod-specs               # Download from prod to specific directory
    $0 --list -e staging                     # List staging specifications

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
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -l|--list)
            LIST_ONLY=true
            shift
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
            if [[ -z "$OBJECT_KEY" ]]; then
                OBJECT_KEY="$1"
            else
                print_error "Multiple object keys provided. Only one can be specified."
                exit 1
            fi
            shift
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

# Auto-detect bucket name if not provided
if [[ -z "$BUCKET_NAME" ]]; then
    BUCKET_NAME="spec-generator-output-$ENVIRONMENT"
    print_status "Using auto-detected bucket name: $BUCKET_NAME"
fi

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

# Function to format file size
format_size() {
    local size=$1
    if [[ $size -lt 1024 ]]; then
        echo "${size}B"
    elif [[ $size -lt 1048576 ]]; then
        echo "$(( size / 1024 ))KB"
    else
        echo "$(( size / 1048576 ))MB"
    fi
}

# Function to list specifications
list_specifications() {
    print_status "Listing specifications in bucket: $BUCKET_NAME"
    
    # Get list of objects with details
    local objects=$(aws s3api list-objects-v2 \
        --bucket "$BUCKET_NAME" \
        --region "$REGION" \
        --query 'Contents[?Size > `0`].[Key,LastModified,Size]' \
        --output text 2>/dev/null)
    
    if [[ -z "$objects" ]]; then
        print_warning "No specifications found in the bucket"
        print_status "This could mean:"
        echo "  - No files have been processed yet"
        echo "  - The Step Functions workflow hasn't completed"
        echo "  - There was an error during processing"
        return 0
    fi
    
    echo
    printf "%-60s %-20s %-10s\n" "SPECIFICATION" "LAST MODIFIED" "SIZE"
    printf "%-60s %-20s %-10s\n" "$(printf '%*s' 60 '' | tr ' ' '-')" "$(printf '%*s' 20 '' | tr ' ' '-')" "$(printf '%*s' 10 '' | tr ' ' '-')"
    
    while IFS=$'\t' read -r key modified size; do
        if [[ -n "$key" ]]; then
            local formatted_size=$(format_size "$size")
            local formatted_date=$(date -d "$modified" "+%Y-%m-%d %H:%M" 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${modified%.*}" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "$modified")
            printf "%-60s %-20s %-10s\n" "$key" "$formatted_date" "$formatted_size"
        fi
    done <<< "$objects"
    
    echo
    local count=$(echo "$objects" | grep -c . || echo "0")
    print_success "Found $count specification(s)"
}

# Function to download a specific file
download_file() {
    local key="$1"
    local filename=$(basename "$key")
    local local_path="$OUTPUT_DIR/$filename"
    
    # Create output directory if it doesn't exist
    mkdir -p "$OUTPUT_DIR"
    
    print_status "Downloading: $key"
    print_status "To: $local_path"
    
    if aws s3 cp "s3://$BUCKET_NAME/$key" "$local_path" --region "$REGION"; then
        print_success "Downloaded successfully: $local_path"
        
        # Show file info
        local file_size=$(stat -f%z "$local_path" 2>/dev/null || stat -c%s "$local_path" 2>/dev/null)
        local formatted_size=$(format_size "$file_size")
        print_status "File size: $formatted_size"
        
        # Try to show a preview if it's a text file
        if file "$local_path" | grep -q "text"; then
            echo
            print_status "Preview (first 10 lines):"
            echo "----------------------------------------"
            head -10 "$local_path"
            echo "----------------------------------------"
        fi
        
        return 0
    else
        print_error "Failed to download: $key"
        return 1
    fi
}

# Function to download all specifications
download_all() {
    print_status "Downloading all specifications from bucket: $BUCKET_NAME"
    
    # Create output directory if it doesn't exist
    mkdir -p "$OUTPUT_DIR"
    
    # Use aws s3 sync to download all files
    if aws s3 sync "s3://$BUCKET_NAME/" "$OUTPUT_DIR/" --region "$REGION" --exclude "*" --include "*.md" --include "*.txt" --include "*.pdf" --include "*.json"; then
        print_success "All specifications downloaded to: $OUTPUT_DIR"
        
        # Count downloaded files
        local count=$(find "$OUTPUT_DIR" -type f | wc -l | tr -d ' ')
        print_status "Downloaded $count file(s)"
        
        # List downloaded files
        if [[ $count -gt 0 ]]; then
            echo
            print_status "Downloaded files:"
            find "$OUTPUT_DIR" -type f -exec basename {} \; | sort
        fi
        
        return 0
    else
        print_error "Failed to download specifications"
        return 1
    fi
}

# Main execution
print_status "S3 Spec Generator Download Tool"
print_status "Environment: $ENVIRONMENT"
print_status "Region: $REGION"
print_status "Bucket: $BUCKET_NAME"

if [[ "$LIST_ONLY" == true ]]; then
    # List specifications only
    list_specifications
elif [[ -n "$OBJECT_KEY" ]]; then
    # Download specific file
    download_file "$OBJECT_KEY"
else
    # Interactive mode - list first, then ask what to download
    list_specifications
    
    echo
    print_status "Download Options:"
    echo "  1. Download all specifications"
    echo "  2. Download specific specification"
    echo "  3. Exit"
    echo
    read -p "Choose an option (1-3): " choice
    
    case $choice in
        1)
            download_all
            ;;
        2)
            echo
            read -p "Enter the object key to download: " selected_key
            if [[ -n "$selected_key" ]]; then
                download_file "$selected_key"
            else
                print_error "No object key provided"
                exit 1
            fi
            ;;
        3)
            print_status "Exiting..."
            exit 0
            ;;
        *)
            print_error "Invalid choice: $choice"
            exit 1
            ;;
    esac
fi