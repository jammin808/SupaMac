#!/bin/sh
# Creates what the services expect behind the in-network AWS endpoint:
# buckets, the upload notification, the DynamoDB tables and the queues. Runs
# in the AWS CLI image, which has that CLI and a shell's builtins and nothing
# else to rely on, and talks to the router as the services do, so it also
# proves that each API reaches its backend and that the object store accepts
# the keys.
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

# The queue service creates the queues of its config that its database lacks,
# and never changes one that is there: a queue from an earlier deployment
# keeps its attributes whatever the config says now. So every queue is made
# sure of here and its attributes are set here, on every deployment. Setting
# an attribute to the value it has changes nothing.
#
# The lines below are the queues of ops/config/elasticmq/elasticmq.conf, which
# says why each attribute is there; a test holds the two lists to each other.
#
#   queue <name> <visibility timeout, s> <delivery delay, s> \
#         <dead-letter queue> <receives before a message goes there>
#
# `-` sets nothing: a new queue then has the queue service's defaults (30
# seconds, no delay, no dead-letter queue) and an old one keeps what it has.
# A dead-letter queue comes before the queue that names it, because it has to
# exist when it is named.
account=000000000000
existing_queues=$(aws sqs list-queues --query 'QueueUrls[]' --output text)
dead_letter_queues=

queue() {
  name=$1 visibility=$2 delay=$3 dead_letters=$4 receives=$5

  found=
  for url in $existing_queues; do
    case $url in
      */"$name") found=yes ;;
    esac
  done
  if [ -z "$found" ]; then
    # FIFO is the one attribute a queue is created with: it cannot be set
    # later.
    case $name in
      *.fifo) aws sqs create-queue --queue-name "$name" --attributes FifoQueue=true >/dev/null ;;
      *) aws sqs create-queue --queue-name "$name" >/dev/null ;;
    esac
    echo "created queue $name"
  fi

  attributes=
  if [ "$visibility" != - ]; then
    attributes="\"VisibilityTimeout\":\"$visibility\""
  fi
  if [ "$delay" != - ]; then
    attributes="${attributes:+$attributes,}\"DelaySeconds\":\"$delay\""
  fi
  if [ "$dead_letters" != - ]; then
    # The policy is a JSON document carried as a string.
    policy="{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:us-east-1:$account:$dead_letters\\\",\\\"maxReceiveCount\\\":$receives}"
    attributes="${attributes:+$attributes,}\"RedrivePolicy\":\"$policy\""
    dead_letter_queues="$dead_letter_queues $dead_letters"
  fi
  if [ -n "$attributes" ]; then
    aws sqs set-queue-attributes \
      --queue-url "$LOCAL_AWS_URL/$account/$name" \
      --attributes "{$attributes}"
  fi
}

queue slack-import-dlq - - - -
queue slack-import-queue 900 - slack-import-dlq 5
queue notification-queue - - - -
queue notification-ingress-queue - - - -
queue push-delivery-queue - - - -
queue webhook-event-queue.fifo - - - -
queue email-service-backfill-queue - - - -
queue email-service-crm-cleanup-queue - - - -
queue email-service-crm-population-queue.fifo 60 10 - -
queue delete-chat-handler-queue - - - -
queue contacts-dlq - - - -
queue contacts-queue - - contacts-dlq 5
queue convert-service-queue - - - -
queue delete-document-handler-queue - - - -
queue document-upload-finalizer-queue - - - -
queue document-text-extractor-lambda-queue - - - -
queue email-service-scheduled-queue - - - -
queue email-service-gmail-inbox-sync-queue - - - -
queue email-service-gmail-inbox-retry-queue - - - -
queue email-service-gmail-ops-queue - - - -
queue email-service-gmail-ops-retry-queue - - - -
queue email-service-refresh-queue 300 - - -
queue email-service-link-maintenance-queue 300 - - -
queue search-event-queue-dlq - - - -
queue search-event-queue 120 - search-event-queue-dlq 2
queue email-sfs-delete-queue - - - -
queue email-service-sfs-mapper-queue - - - -
queue static-file-s3-event-notification-queue - - - -
queue reminder-dispatch-queue - - - -
queue calendar-reminder-dispatch-queue - - - -
queue calendar-service-backfill-queue - - - -

# Nothing watches a dead-letter queue and nothing empties one: a message
# there failed as often as its queue allows. This line in the job's log, once
# per deployment, is where one shows.
for name in $dead_letter_queues; do
  count=$(aws sqs get-queue-attributes \
    --queue-url "$LOCAL_AWS_URL/$account/$name" \
    --attribute-names ApproximateNumberOfMessages \
    --query Attributes.ApproximateNumberOfMessages --output text) || count=unknown
  echo "dead-letter queue $name holds $count messages"
done

# The keys come from the KMS seed. A service that finds one missing fails
# later and less clearly than this job does now.
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
