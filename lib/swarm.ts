import type { HeadersInit, RequestInit } from "undici";
import type { ProxyConfig, ProxyProvider } from "./provider";
import process from "node:process";
import { fetch, ProxyAgent } from "undici";
import { sleep } from "./util";
import "colors";

export class Proxy {
  host: string;
  port: number;
  agent: ProxyAgent;
  constructor(config: ProxyConfig) {
    this.host = config.host;
    this.port = config.port;
    const uri = `http://${config.username}:${config.password}@${config.host}:${config.port}`;
    const agent = new ProxyAgent(uri);
    this.agent = agent;
  }
}

interface SwarmOpts {
  proxies?: (string | Proxy)[];
  providers?: ProxyProvider[];
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  waitForProxiesReady?: boolean;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  proxyTimeoutMs?: number;
  startupBehavior?: "terminate";
  shutdownBehavior?: "terminate";
}

interface SwarmConfig {
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  waitForProxiesReady: boolean;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  proxyTimeoutMs: number;
  startupBehavior: "terminate" | null;
  shutdownBehavior: "terminate" | null;
}

class ProxySwarm {
  private config: SwarmConfig;
  private proxies: Proxy[] = [];
  private providers: ProxyProvider[] = [];
  private urlQueue: string[] = [];
  private currentIndex: number = 0;
  private runningProxies: Set<string> = new Set();

  private defaultHeaders: HeadersInit = {
    "accept": "application/json, text/plain, */*",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "en-US,en;q=0.9",
    "connection": "keep-alive",
    "content-type": "application/json",
    // this.headers["Origin"] = this.baseUrl;
    // this.headers["Referer"] = this.baseUrl;
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-ch-ua": `"Chromium";v="130", "Google Chrome";v="130"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": `"macOS"`,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  };

  constructor({ proxies, providers, ...opts }: SwarmOpts) {
    this.config = {
      waitForProxiesReady: true,
      pingIntervalMs: 5000,
      pingTimeoutMs: 15000,
      proxyTimeoutMs: 15000,
      startupBehavior: null,
      shutdownBehavior: null,
      ...opts,
    };
    if (!proxies?.length && !providers?.length) {
      throw new Error("No proxies or providers given");
    }
    if (proxies) {
      for (const rawProxy of proxies) {
        if (typeof rawProxy === "string") {
          if (!this.config.proxyPort || !this.config.proxyUsername || !this.config.proxyPassword) {
            throw new Error("Proxy port, username, and password are required");
          }
          const proxy = new Proxy({
            host: rawProxy,
            port: this.config.proxyPort,
            username: this.config.proxyUsername,
            password: this.config.proxyPassword,
          });
          this.proxies.push(proxy);
        }
        else if (rawProxy instanceof Proxy) {
          this.proxies.push(rawProxy);
        }
        else {
          throw new TypeError(`Invalid proxy: ${rawProxy}`);
        }
      }
    }
    if (providers) {
      this.providers = providers;
      const onReady = (config: ProxyConfig) => {
        const proxy = new Proxy(config);
        this.proxies.push(proxy);
      };
      const startupBehavior = this.config.startupBehavior;
      (async () => {
        if (startupBehavior === "terminate") {
          await Promise.all(providers.map(p => p.terminate(true)));
        }
        await Promise.all(providers.map(p => p.start({ onReady })));
      })();
    }

    const infoStr = [
      this.proxies.length ? `${this.proxies.length} prox${this.proxies.length > 1 ? "ies" : "y"}` : "",
      this.providers.length ? `${this.providers.length} provider${this.providers.length > 1 ? "s" : ""}` : "",
    ].filter(Boolean).join(" and ");
    this.log(`Initializing ${infoStr}...`);
    this.pingProxies();
    process.on("SIGINT", this.cleanup.bind(this));
  }

  private log(message: string, ...args: unknown[]): void {
    console.log(`${"[ProxySwarm]".yellow} ${message}`, ...args);
  }

  private error(message: string, ...args: unknown[]): void {
    console.error(`[ProxySwarm] ${message}`.red, ...args);
  }

  private async pingProxies(): Promise<void> {
    while (true) {
      if (this.proxies.length === 0) {
        await sleep(this.config.pingIntervalMs);
        continue;
      }

      const startTime = Date.now();
      await Promise.all(
        Array.from(this.proxies.values(), async (proxy) => {
          if (this.runningProxies.has(proxy.host)) {
            return;
          }
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.config.pingTimeoutMs);
            await fetch(`http://${proxy.host}:${proxy.port}/`, { signal: controller.signal });
            clearTimeout(timeout);
            this.runningProxies.add(proxy.host);
          }
          catch {
            this.runningProxies.delete(proxy.host);
          }
        }),
      );
      const endTime = Date.now();
      const elapsed = endTime - startTime;
      if (elapsed < this.config.pingIntervalMs) {
        await sleep(this.config.pingIntervalMs - elapsed);
      }
    }
  }

  async waitForProxiesReady(): Promise<void> {
    if (!this.proxies.length) {
      await sleep(this.config.pingIntervalMs);
      await this.waitForProxiesReady();
    }
    if (this.config.waitForProxiesReady && this.runningProxies.size !== this.proxies.length) {
      this.log(`Waiting for proxies to be ready (${this.runningProxies.size}/${this.proxies.length})`);
      await sleep(this.config.pingIntervalMs);
      await this.waitForProxiesReady();
    }
  }

  async get(url: string) {
    await this.waitForProxiesReady();

    const proxy = this.proxies[Math.floor(Math.random() * this.proxies.length)]; // stupid load balancing
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.proxyTimeoutMs);
    const requestConfig: RequestInit = {
      method: "GET",
      headers: this.defaultHeaders,
      dispatcher: proxy.agent,
      signal: controller.signal,
    };

    try {
      const shortUrl = url.length > 50 ? `${url.slice(0, 40)}...` : url;
      this.log(`GET ${shortUrl} (${proxy.host})`);
      const res = await fetch(url, requestConfig);
      return res;
    }
    catch (error) {
      this.error(`Unhandled error fetching ${url} (${proxy.host}):`, error);
    }
    finally {
      clearTimeout(timeout);
    }
  }

  async batch(
    urls: string[],
    handler: (res: Response, proxy?: Proxy, url?: string) => Promise<void> | void,
    errorHandler?: (error: unknown, proxy?: Proxy, url?: string) => Promise<void> | void,
  ): Promise<void> {
    await this.waitForProxiesReady();

    this.log(`Running ${urls.length} URLs`);

    this.urlQueue.push(...urls);
    const workers = this.proxies.map(proxy => this.runWorker(proxy, handler, errorHandler));
    await Promise.all(workers);
  }

  async runWorker(
    proxy: Proxy,
    handler?: (res: Response, proxy?: Proxy, url?: string) => Promise<void> | void,
    errorHandler?: (error: unknown, proxy?: Proxy, url?: string) => Promise<void> | void,
  ): Promise<void> {
    while (true) {
      const url = this.urlQueue[this.currentIndex++];
      if (!url) {
        break;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.proxyTimeoutMs);
      const requestConfig: RequestInit = {
        method: "GET",
        headers: this.defaultHeaders,
        dispatcher: proxy.agent,
        signal: controller.signal,
      };

      try {
        this.log(`GET ${url} (${proxy.host})`);
        const res = await fetch(url, requestConfig);
        if (handler) {
          await handler(res, proxy, url);
        }
      }
      catch (error) {
        if (errorHandler) {
          await errorHandler(error, proxy, url);
        }
        else {
          this.error(`Unhandled error fetching ${url} (${proxy.host}):`, error);
        }
      }
      finally {
        clearTimeout(timeout);
      }
    }
  }

  private async cleanup(): Promise<void> {
    if (this.proxies.length) {
      this.log("Closing proxy connections");
      for (const proxy of this.proxies) {
        try {
          await proxy.agent.close();
        }
        catch {}
      }
    }
    if (this.providers.length && this.config.shutdownBehavior === "terminate") {
      this.log("Terminating provider instances");
      for (const provider of this.providers) {
        await provider.terminate();
      }
    }
    process.exit(0);
  }
}

export default ProxySwarm;
