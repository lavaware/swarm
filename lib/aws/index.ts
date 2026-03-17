import type { ProxyConfig, ProxyProviderConfig, ProxyProviderOpts } from "../provider";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ec2 from "@aws-sdk/client-ec2";
import * as serviceQuotas from "@aws-sdk/client-service-quotas";
import { ProxyProvider } from "../provider";
import { sleep } from "../util";
import "colors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface AwsProxyProviderOpts extends ProxyProviderOpts {
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  region?: string;
  keyName?: string;
  instanceType?: ec2._InstanceType;
  instanceName?: string;
  securityGroupName?: string;
}

interface AwsProxyProviderConfig extends ProxyProviderConfig {
  region: string;
  keyName: string;
  instanceType: ec2._InstanceType;
  instanceName: string;
  securityGroupName: string;
}

export class AwsProxyProvider extends ProxyProvider {
  public config: AwsProxyProviderConfig;
  private ec2Client: ec2.EC2Client;
  private serviceQuotasClient: serviceQuotas.ServiceQuotasClient;
  private isTerminating = false;
  constructor({ credentials, ...opts }: AwsProxyProviderOpts) {
    super();
    this.config = {
      name: `AWS:${opts.region ?? "us-east-1"}`,
      region: "us-east-1",
      keyName: "proxy-swarm",
      instanceType: "t2.micro",
      instanceName: "proxy",
      securityGroupName: "proxy-swarm",
      pingIntervalMs: 2000,
      includeExisting: true,
      ...opts,
    };
    this.ec2Client = new ec2.EC2Client({
      region: this.config.region,
      credentials,
    });
    this.serviceQuotasClient = new serviceQuotas.ServiceQuotasClient({
      region: this.config.region,
      credentials,
    });
  }

  /**
   * Start AWS proxy instances
   * @returns Array of public IP addresses of the launched instances
   */
  async start({ onReady }: { onReady?: (config: ProxyConfig) => void }) {
    try {
      const activeInstances = await this.getActiveInstances();
      const activeInstanceIds = activeInstances.map(instance => instance.InstanceId!);
      const availableCount = await this.getInstanceCapacity();
      const desiredCount = this.config.instanceCount;
      const activeCount = activeInstances.length;

      if (desiredCount !== undefined) {
        if (activeCount >= desiredCount) {
          this.log(`Already running ${activeCount} instances`);
          await this.waitForPublicIp(activeInstanceIds, onReady);
          return;
        }
        if (availableCount + activeCount < desiredCount) {
          this.error("Insufficient instance capacity");
          return;
        }
      }
      if (availableCount === 0) {
        if (activeCount === 0) {
          this.error("No instances available");
          return;
        }
        else {
          this.log(`Already running ${activeCount} instances`);
          await this.waitForPublicIp(activeInstanceIds, onReady);
          return;
        }
      }

      if (this.isTerminating) {
        return;
      }

      const instanceCount = desiredCount ? Math.max(0, desiredCount - activeCount) : availableCount;
      const amiId = await this.getLatestDebianAmiId();
      if (!amiId) {
        throw new Error("No Debian 13 AMI found");
      }

      await this.ensureKeyPair();
      await this.ensureSecurityGroup();

      const startupScript = ProxyProvider.getStartupScript(this.config.proxyUsername, this.config.proxyPassword);
      const userData = Buffer.from(startupScript).toString("base64");

      this.log(`Launching ${instanceCount} instances`);
      const command = new ec2.RunInstancesCommand({
        ImageId: amiId,
        MinCount: 1,
        MaxCount: instanceCount,
        InstanceType: this.config.instanceType,
        SecurityGroups: [this.config.securityGroupName],
        KeyName: this.config.keyName,
        UserData: userData,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              {
                Key: "Name",
                Value: this.config.instanceName,
              },
            ],
          },
        ],
      });
      const response = await this.ec2Client.send(command);
      const launchedInstanceIds = response.Instances?.map(instance => instance.InstanceId).filter(Boolean) as string[];
      if (!launchedInstanceIds) {
        throw new Error("No instances launched");
      }
      this.log(`Launched ${launchedInstanceIds.length} instances: ${launchedInstanceIds.join(", ").blue}`);
      await this.waitForPublicIp([...activeInstanceIds, ...launchedInstanceIds], onReady);
    }
    catch (error) {
      this.error("Error launching instances:", error as Error);
      throw error;
    }
  }

  /**
   * Get all running or pending instances.
   * @returns Array of active instances
   */
  private async getActiveInstances(): Promise<ec2.Instance[]> {
    const describeCommand = new ec2.DescribeInstancesCommand({
      Filters: [
        {
          Name: "tag:Name",
          Values: [this.config.instanceName],
        },
        {
          Name: "instance-state-name",
          Values: ["running", "pending"],
        },
      ],
    });
    const describeResponse = await this.ec2Client.send(describeCommand);
    const instances = describeResponse.Reservations?.flatMap(reservation => reservation.Instances ?? []) ?? [];
    return instances;
  }

  private log(message: string, ...args: unknown[]): void {
    const name = `[${this.config.name}]`.blue;
    console.log(`${name} ${message}`, ...args);
  }

  private error(message: string, ...args: unknown[]): void {
    const name = `[${this.config.name}]`.red;
    console.error(`${name} ${message}`, ...args);
  }

  /**
   * Check if key pair exists and create it if it doesn't
   */
  private async ensureKeyPair(): Promise<void> {
    if (this.isTerminating) {
      return;
    }
    this.log(`Ensuring key pair "${this.config.keyName}" exists`);
    try {
      const describeCommand = new ec2.DescribeKeyPairsCommand({
        KeyNames: [this.config.keyName],
      });
      try {
        // Check if key pair exists
        await this.ec2Client.send(describeCommand);
        return;
      }
      catch (error) {
        if ((error as any).Code !== "InvalidKeyPair.NotFound") {
          this.error("Error describing key pair:", error);
        }
      }

      const keyDir = path.resolve(__dirname, "../../keys");
      await mkdir(keyDir, { recursive: true });

      const keyPath = path.resolve(keyDir, this.config.keyName);
      if (!fs.existsSync(keyPath)) {
        const { execSync } = await import("node:child_process");
        execSync(`ssh-keygen -t ed25519 -f ${keyPath} -N "" -q`);
      }

      const publicKeyPath = `${keyPath}.pub`;
      const publicKeyBuffer = Buffer.from(fs.readFileSync(publicKeyPath, "utf8"));
      const createCommand = new ec2.ImportKeyPairCommand({
        KeyName: this.config.keyName,
        PublicKeyMaterial: publicKeyBuffer,
      });

      await this.ec2Client.send(createCommand);
      fs.chmodSync(keyPath, 0o600);
      this.log(`Created key pair "${this.config.keyName}" in ${keyDir}`);
    }
    catch (error) {
      this.error("Error creating key pair:", error);
      throw error;
    }
  }

  /**
   * Check if security group exists and create it if it doesn't
   * @returns The security group ID
   */
  private async ensureSecurityGroup(): Promise<string | void> {
    if (this.isTerminating) {
      return;
    }
    this.log(`Ensuring security group "${this.config.securityGroupName}" exists`);
    try {
      // Check if security group exists
      const describeCommand = new ec2.DescribeSecurityGroupsCommand({
        GroupNames: [this.config.securityGroupName],
      });

      try {
        const response = await this.ec2Client.send(describeCommand);
        if (response.SecurityGroups && response.SecurityGroups.length > 0) {
          return response.SecurityGroups[0].GroupId!;
        }
      }
      catch (error) {
        if (error instanceof Error && error.message.includes("InvalidGroup.NotFound")) {
          this.log(`Creating security group "${this.config.securityGroupName}"`);
        }
        else {
          this.error("Error describing security group:", error);
          throw error;
        }
      }

      // Create security group
      const createCommand = new ec2.CreateSecurityGroupCommand({
        GroupName: this.config.securityGroupName,
        Description: "Security group for proxy instances",
      });

      const createResponse = await this.ec2Client.send(createCommand);
      const groupId = createResponse.GroupId!;

      // Add inbound rules
      const authorizeCommand = new ec2.AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [
          {
            IpProtocol: "tcp",
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
          {
            IpProtocol: "tcp",
            FromPort: 8081,
            ToPort: 8081,
            IpRanges: [{ CidrIp: "0.0.0.0/0" }],
          },
        ],
      });

      await this.ec2Client.send(authorizeCommand);
      this.log(`Created security group "${this.config.securityGroupName}" with ID ${groupId}`);
      return groupId;
    }
    catch (error) {
      this.error("Error creating security group:", error);
      throw error;
    }
  }

  /**
   * Wait for instances to have a public IP
   * @param instanceIds Array of instance IDs to wait for
   */
  private async waitForPublicIp(
    instanceIds: string[],
    onReady?: (config: ProxyConfig) => void,
  ): Promise<void> {
    const instanceIps = new Set<string>();

    while (true) {
      if (this.isTerminating) {
        return;
      }
      const describeCommand = new ec2.DescribeInstancesCommand({ InstanceIds: instanceIds });
      const describeResponse = await this.ec2Client.send(describeCommand);
      describeResponse.Reservations?.forEach((reservation: ec2.Reservation) => {
        reservation.Instances?.forEach((instance: ec2.Instance) => {
          if (instance.PublicIpAddress) {
            instanceIps.add(instance.PublicIpAddress);
          }
        });
      });
      if (instanceIps.size === instanceIds.length) {
        break;
      }
      this.log(`Waiting for public IPs (${instanceIps.size}/${instanceIds.length})`);
      await sleep(this.config.pingIntervalMs);
    }

    this.log(`All instances public: ${[...instanceIps].join(", ").blue}`);
    for (const ip of instanceIps) {
      onReady?.({
        host: ip,
        port: this.config.proxyPort,
        username: this.config.proxyUsername,
        password: this.config.proxyPassword,
      });
    }
  }

  /**
   * Terminate all proxy instances
   */
  async terminate(waitForTerminated = false): Promise<this> {
    try {
      this.isTerminating = true;
      const describeCommand = new ec2.DescribeInstancesCommand({
        Filters: [
          {
            Name: "tag:Name",
            Values: [this.config.instanceName],
          },
          {
            Name: "instance-state-name",
            Values: ["running", "pending", "stopped"],
          },
        ],
      });

      const describeResponse = await this.ec2Client.send(describeCommand);
      const instanceIds: string[] = [];

      describeResponse.Reservations?.forEach((reservation: ec2.Reservation) => {
        reservation.Instances?.forEach((instance: ec2.Instance) => {
          if (instance.InstanceId) {
            instanceIds.push(instance.InstanceId);
          }
        });
      });

      if (instanceIds.length === 0) {
        return this;
      }

      if (!waitForTerminated) {
        this.log(`Terminating all instances (${instanceIds.length})`);
      }

      const terminateCommand = new ec2.TerminateInstancesCommand({
        InstanceIds: instanceIds,
      });
      await this.ec2Client.send(terminateCommand);

      if (waitForTerminated) {
        const confirmedTerminated = new Set<string>();
        do {
          const describeCommand = new ec2.DescribeInstancesCommand({
            InstanceIds: instanceIds,
          });
          const describeResponse = await this.ec2Client.send(describeCommand);
          describeResponse.Reservations?.forEach((reservation: ec2.Reservation) => {
            reservation.Instances?.forEach((instance: ec2.Instance) => {
              if (instance.State?.Name === "terminated" && instance.InstanceId) {
                confirmedTerminated.add(instance.InstanceId);
              }
            });
          });
          if (confirmedTerminated.size !== instanceIds.length) {
            await sleep(this.config.pingIntervalMs);
          }
          this.log(`Terminating instances (${confirmedTerminated.size}/${instanceIds.length})`);
        } while (confirmedTerminated.size !== instanceIds.length);
      }

      this.log(`Terminated instances: ${instanceIds.join(", ").red}`);

      return this;
    }
    catch (error) {
      this.error("Error terminating instances:", error);
      throw error;
    }
  }

  /**
   * Get the latest Debian AMI ID
   * @returns The latest Debian AMI ID
   */
  async getLatestDebianAmiId() {
    const AMAZON_OWNER_ID = "136693071363";
    const DEBIAN_13_NAME_PATTERN = `debian-13-amd64-${new Date().getFullYear()}*`;
    const command = new ec2.DescribeImagesCommand({
      Filters: [
        { Name: "owner-id", Values: [AMAZON_OWNER_ID] },
        { Name: "name", Values: [DEBIAN_13_NAME_PATTERN] },
        { Name: "architecture", Values: ["x86_64"] },
        { Name: "state", Values: ["available"] },
      ],
    });
    const response = await this.ec2Client.send(command);
    const latestImage = response.Images
      ?.sort((a, b) => new Date(b.CreationDate!).getTime() - new Date(a.CreationDate!).getTime())[0];
    return latestImage?.ImageId;
  }

  /**
   * Get the maximum allowed running vCPUs for the AWS account
   * @returns The maximum number of running vCPUs allowed
   */
  async getInstanceCapacity(): Promise<number> {
    const ON_DEMAND_QUOTA_CODE = "L-1216C47A";

    const describeInstanceTypesCommand = new ec2.DescribeInstanceTypesCommand({
      InstanceTypes: [this.config.instanceType],
    });
    const instanceTypesResponse = await this.ec2Client.send(describeInstanceTypesCommand);
    const instanceTypeInfo = instanceTypesResponse.InstanceTypes?.[0];
    const instanceVcpuCount = instanceTypeInfo?.VCpuInfo?.DefaultVCpus ?? 0;
    if (instanceVcpuCount === 0) {
      throw new Error(`Could not determine vCPU count for instance type ${this.config.instanceType}`);
    }

    // Fetch all running instances.
    const runningInstances: ec2.Instance[] = [];
    let nextToken: string | undefined;
    do {
      const describeInstancesCommand = new ec2.DescribeInstancesCommand({
        Filters: [{ Name: "instance-state-name", Values: ["running"] }],
        NextToken: nextToken,
      });
      const describeResponse = await this.ec2Client.send(describeInstancesCommand);
      for (const reservation of describeResponse.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (!instance.InstanceLifecycle) {
            // Only include on-demand instances, since that is
            // what the quota code applies to.
            runningInstances.push(instance);
          }
        }
      }
      nextToken = describeResponse.NextToken;
    } while (nextToken);

    // Resolve vCPU count for each unique instance type in use
    const uniqueInstanceTypes = [...new Set(runningInstances.map(i => i.InstanceType).filter(Boolean))] as ec2._InstanceType[];
    const vcpuByInstanceType = new Map<string, number>();
    const BATCH_SIZE = 100;
    for (let i = 0; i < uniqueInstanceTypes.length; i += BATCH_SIZE) {
      const batch = uniqueInstanceTypes.slice(i, i + BATCH_SIZE);
      const batchResponse = await this.ec2Client.send(
        new ec2.DescribeInstanceTypesCommand({ InstanceTypes: batch }),
      );
      for (const it of batchResponse.InstanceTypes ?? []) {
        const vcpus = it.VCpuInfo?.DefaultVCpus;
        if (it.InstanceType != null && vcpus != null) {
          vcpuByInstanceType.set(it.InstanceType, vcpus);
        }
      }
    }

    const usedVcpuCount = runningInstances.reduce((sum, instance) => {
      const vcpus = instance.InstanceType ? vcpuByInstanceType.get(instance.InstanceType!) : undefined;
      return sum + (vcpus ?? 0);
    }, 0);

    const getServiceQuotaCommand = new serviceQuotas.GetServiceQuotaCommand({
      ServiceCode: "ec2",
      QuotaCode: ON_DEMAND_QUOTA_CODE,
    });
    const serviceQuotaResponse = await this.serviceQuotasClient.send(getServiceQuotaCommand);
    const quotaVcpuCount = serviceQuotaResponse.Quota?.Value ?? 0;

    const remainingVcpus = Math.max(0, quotaVcpuCount - usedVcpuCount);
    const availableInstanceCount = Math.floor(remainingVcpus / instanceVcpuCount);

    return availableInstanceCount;
  }
}
