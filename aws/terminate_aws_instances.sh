#!/bin/bash

INSTANCE_NAME="Proxy"

INSTANCE_IDS=$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=running,pending,stopped" \
    --query "Reservations[*].Instances[*].InstanceId" \
    --output text)

if [ -z "$INSTANCE_IDS" ]; then
    echo "No instances found with name $INSTANCE_NAME."
    exit 0
fi

# Terminate the instances
aws ec2 terminate-instances --instance-ids $INSTANCE_IDS

echo "Terminating instances: $INSTANCE_IDS"