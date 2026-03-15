#!/bin/bash

INSTANCE_COUNT=80
INSTANCE_NAME="Proxy"
AMI_ID=ami-0b40807e5dc1afecf
INSTANCE_TYPE="t2.micro"
SECURITY_GROUP="ProxyGroup"
KEY_NAME="id_aws_proxy"
USER_DATA_FILE="./bootstrap.sh"

aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --count "$INSTANCE_COUNT" \
    --instance-type "$INSTANCE_TYPE" \
    --security-groups "$SECURITY_GROUP" \
    --key-name "$KEY_NAME" \
    --user-data file://$USER_DATA_FILE \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]"

echo "Launched $INSTANCE_COUNT instances with name $INSTANCE_NAME."

list_images() {
    aws ec2 describe-images --filters "Name=name,Values=*debian*" --query "Images[*]" --output table
}
