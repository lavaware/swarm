export interface ProxyProviderOpts {
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  name?: string;
  instanceCount?: number;
  pingIntervalMs?: number;
  includeExisting?: boolean;
}

export interface ProxyProviderConfig {
  name: string;
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  instanceCount?: number;
  pingIntervalMs: number;
  includeExisting: boolean;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}
export abstract class ProxyProvider {
  public abstract config: ProxyProviderConfig;
  static getStartupScript(username: string, password: string) {
    const SCRIPT_URL = "https://raw.githubusercontent.com/lavaware/swarm/refs/heads/master/scripts/setup.sh";
    return [
      `#!/bin/bash`,
      `set -euxo pipefail`,
      `exec > /var/log/user-data-debug.log 2>&1`,
      `curl -fsSL "${SCRIPT_URL}" -o /tmp/setup.sh`,
      `chmod +x /tmp/setup.sh`,
      `PROXY_USERNAME="${username}" PROXY_PASSWORD="${password}" bash /tmp/setup.sh`,
    ].join("\n");
  }
  abstract start({ onReady }: { onReady?: (config: ProxyConfig) => void }): Promise<void>;
  abstract terminate(waitForTerminated?: boolean): Promise<this>;
}
