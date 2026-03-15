#!/bin/bash

> .proxies # Overwrite .proxies file.

aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=Proxy" "Name=instance-state-name,Values=running" \
    --query "Reservations[*].Instances[*].PublicIpAddress" \
    --output text | awk '{for (i=1; i<=NF; i++) print $i}' > .proxies