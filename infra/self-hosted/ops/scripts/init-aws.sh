#!/bin/sh
# Creates what the services expect behind the in-network AWS endpoint:
# buckets, the upload notification and the DynamoDB tables. Runs in the AWS
# CLI image and talks to the router as the services do, so it also proves that
# each API reaches its backend and that the object store accepts the keys.
#
# Names and schemas are those of the local stack
# (tooling/xtask/crates/xtask_local/src/local/resources.rs, localstack.rs).
set -eu

export AWS_PAGER=""
export AWS_EC2_METADATA_DISABLED=true

aws() {
  command aws --endpoint-url "$LOCAL_AWS_URL" "$@"
}

for bucket in \
  macro-email-attachments \
  doc-storage \
  docx-upload \
  static-file-storage \
  bulk-upload-staging \
  macro-call-recording-local \
  agent-session-changes \
  github-pull-request-patches
do
  # A new bucket has no policy and answers signed requests only.
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    aws s3api create-bucket --bucket "$bucket" >/dev/null
  fi
done

# Static files are public by their unguessable key, as behind the CDN
# upstream: anyone may read an object, nobody may list or write.
aws s3api put-bucket-policy --bucket static-file-storage --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"AWS": ["*"]},
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::static-file-storage/*"]
  }]
}'

# A document upload is finished by the finalizer, which hears of it through
# this event. UPLOADS is the webhook target the object store is started with.
aws s3api put-bucket-notification-configuration --bucket doc-storage \
  --notification-configuration '{
    "QueueConfigurations": [{
      "Id": "document-upload-finalizer",
      "QueueArn": "arn:minio:sqs:us-east-1:UPLOADS:webhook",
      "Events": ["s3:ObjectCreated:*"]
    }]
  }'

table_exists() {
  aws dynamodb describe-table --table-name "$1" >/dev/null 2>&1
}

if ! table_exists bulk-upload; then
  aws dynamodb create-table --table-name bulk-upload \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --global-secondary-indexes '[{
      "IndexName": "DocumentPkIndex",
      "KeySchema": [{"AttributeName": "SK", "KeyType": "HASH"}],
      "Projection": {"ProjectionType": "ALL"}
    }]' >/dev/null
fi

if ! table_exists connection-gateway-table; then
  aws dynamodb create-table --table-name connection-gateway-table \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --global-secondary-indexes '[{
      "IndexName": "ConnectionPkIndex",
      "KeySchema": [
        {"AttributeName": "SK", "KeyType": "HASH"},
        {"AttributeName": "PK", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }]' >/dev/null
fi

if ! table_exists static-file-metadata; then
  aws dynamodb create-table --table-name static-file-metadata \
    --attribute-definitions AttributeName=file_id,AttributeType=S \
    --key-schema AttributeName=file_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
fi

# The queues come from the queue service's own config and the keys from the
# KMS seed. A service that finds one missing fails later and less clearly
# than this job does now.
aws sqs get-queue-url --queue-name document-upload-finalizer-queue >/dev/null
for alias in \
  alias/macro-local-cursor-api-key \
  alias/macro-local-codex-oauth \
  alias/macro-local-mcp-oauth \
  alias/macro-local-microsoft-token \
  alias/whatsapp-session-service-local
do
  aws kms describe-key --key-id "$alias" >/dev/null
done

echo "buckets, upload notification, tables, queues and keys are in place"
