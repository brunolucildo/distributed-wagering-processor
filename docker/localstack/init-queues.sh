#!/bin/bash
set -eu

region="${AWS_DEFAULT_REGION:-sa-east-1}"

awslocal sqs create-queue \
  --region "$region" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

dlq_url="$(awslocal sqs get-queue-url \
  --region "$region" \
  --queue-name wager-transactions-dlq.fifo \
  --query QueueUrl \
  --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes \
  --region "$region" \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn \
  --output text)"

awslocal sqs create-queue \
  --region "$region" \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,VisibilityTimeout=60 >/dev/null

wager_url="$(awslocal sqs get-queue-url \
  --region "$region" \
  --queue-name wager-transactions.fifo \
  --query QueueUrl \
  --output text)"
redrive_policy="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "$dlq_arn")"
escaped_redrive_policy="$(printf '%s' "$redrive_policy" | sed 's/"/\\"/g')"

awslocal sqs set-queue-attributes \
  --region "$region" \
  --queue-url "$wager_url" \
  --attributes "{\"RedrivePolicy\":\"$escaped_redrive_policy\"}"

awslocal sqs create-queue \
  --region "$region" \
  --queue-name integration-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

echo "Provisioned wager, dead-letter, and integration-events FIFO queues."
