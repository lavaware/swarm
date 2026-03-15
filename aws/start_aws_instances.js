const { EC2Client, RunInstancesCommand } = require('@aws-sdk/client-ec2');
const fs = require('fs');

// Configuration
const INSTANCE_COUNT = 80;
const INSTANCE_NAME = "Proxy";
const AMI_ID = "ami-0b40807e5dc1afecf";
const INSTANCE_TYPE = "t2.micro";
const SECURITY_GROUP = "ProxyGroup";
const KEY_NAME = "id_aws_proxy";
const USER_DATA_FILE = "./startup.sh";

// Initialize EC2 client
const ec2Client = new EC2Client({
  region: process.env.AWS_REGION || 'us-east-1', // Default to us-east-1 if not specified
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function startInstances() {
  try {
    // Read user data script
    const userData = fs.readFileSync(USER_DATA_FILE, 'utf8');

    const command = new RunInstancesCommand({
      ImageId: AMI_ID,
      MinCount: INSTANCE_COUNT,
      MaxCount: INSTANCE_COUNT,
      InstanceType: INSTANCE_TYPE,
      SecurityGroups: [SECURITY_GROUP],
      KeyName: KEY_NAME,
      UserData: Buffer.from(userData).toString('base64'),
      TagSpecifications: [{
        ResourceType: 'instance',
        Tags: [{
          Key: 'Name',
          Value: INSTANCE_NAME
        }]
      }]
    });

    const response = await ec2Client.send(command);
    console.log(`Launched ${INSTANCE_COUNT} instances with name ${INSTANCE_NAME}`);
    return response;
  } catch (error) {
    console.error('Error launching instances:', error);
    throw error;
  }
}

// Helper function to list available AMIs (equivalent to list_images in bash script)
async function listImages() {
  try {
    const command = new DescribeImagesCommand({
      Filters: [{
        Name: 'name',
        Values: ['*debian*']
      }]
    });
    
    const response = await ec2Client.send(command);
    console.table(response.Images);
    return response.Images;
  } catch (error) {
    console.error('Error listing images:', error);
    throw error;
  }
}

// Export functions for use in other files
module.exports = {
  startInstances,
  listImages
};

// If this file is run directly, start the instances
if (require.main === module) {
  startInstances();
} 