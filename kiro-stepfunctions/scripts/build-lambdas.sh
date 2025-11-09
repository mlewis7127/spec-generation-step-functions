#!/bin/bash

# Build Lambda functions from TypeScript to JavaScript
set -e

echo "Building Lambda functions..."

# Create dist directory structure
mkdir -p dist/lambda/read-file
mkdir -p dist/lambda/process-with-claude
mkdir -p dist/lambda/write-specification
mkdir -p dist/lambda/send-notification
mkdir -p dist/shared

# Compile TypeScript to JavaScript
echo "Compiling TypeScript..."
npx tsc --project tsconfig.lambda.json

# Copy package.json files for each Lambda function
echo "Creating package.json files for Lambda functions..."

# ReadFile Lambda
cat > dist/lambda/read-file/package.json << 'EOF'
{
  "name": "read-file-function",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "aws-sdk": "^2.1490.0"
  }
}
EOF

# ProcessWithClaude Lambda
cat > dist/lambda/process-with-claude/package.json << 'EOF'
{
  "name": "process-with-claude-function",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "aws-sdk": "^2.1490.0",
    "@aws-sdk/client-bedrock-runtime": "^3.450.0"
  }
}
EOF

# WriteSpecification Lambda
cat > dist/lambda/write-specification/package.json << 'EOF'
{
  "name": "write-specification-function",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "aws-sdk": "^2.1490.0"
  }
}
EOF

# SendNotification Lambda
cat > dist/lambda/send-notification/package.json << 'EOF'
{
  "name": "send-notification-function",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "aws-sdk": "^2.1490.0"
  }
}
EOF

echo "Copying shared modules to each Lambda function..."

# Copy shared modules to each Lambda function directory
cp -r dist/shared dist/lambda/read-file/
cp -r dist/shared dist/lambda/process-with-claude/
cp -r dist/shared dist/lambda/write-specification/
cp -r dist/shared dist/lambda/send-notification/

echo "Fixing import paths in compiled JavaScript..."

# Fix import paths in each Lambda function
sed -i '' 's|require("../../shared/|require("./shared/|g' dist/lambda/read-file/index.js
sed -i '' 's|require("../../shared/|require("./shared/|g' dist/lambda/process-with-claude/index.js
sed -i '' 's|require("../../shared/|require("./shared/|g' dist/lambda/write-specification/index.js
sed -i '' 's|require("../../shared/|require("./shared/|g' dist/lambda/send-notification/index.js

echo "Installing dependencies for Lambda functions..."

# Install dependencies for each Lambda function
cd dist/lambda/read-file && npm install --production --silent
cd ../../../

cd dist/lambda/process-with-claude && npm install --production --silent
cd ../../../

cd dist/lambda/write-specification && npm install --production --silent
cd ../../../

cd dist/lambda/send-notification && npm install --production --silent
cd ../../../

echo "Lambda functions built successfully!"