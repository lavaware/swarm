export interface ProxyProviderOpts {
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  instanceCount?: number;
  pingIntervalMs?: number;
}

export interface ProxyProviderConfig {
  proxyPort: number;
  proxyUsername: string;
  proxyPassword: string;
  instanceCount?: number;
  pingIntervalMs: number;
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
    return `curl -fsSL ${SCRIPT_URL} | PROXY_USERNAME="${username}" PROXY_PASSWORD="${password}" sudo -E bash;`;
  }
  abstract start({ onReady }: { onReady?: (config: ProxyConfig) => void }): Promise<void>;
  abstract stop(): Promise<void>;
}
