import type { HeadersInit, ProxyAgent, RequestInit } from "undici";
import type { ProxyConfig, ProxyProvider } from "./provider";
import process from "node:process";
import { fetch } from "undici";
import { HttpsProxyAgent } from "./agent";
import { Timer } from "./timer";
import { sleep } from "./util";
import "colors";

export class Proxy {
  host: string;
  port: number;
  agent: HttpsProxyAgent<string>;
  constructor(config: ProxyConfig) {
    this.host = config.host;
    this.port = config.port;
    const url = `http://${config.username}:${config.password}@${config.host}:${config.port}`;
    const agent = new HttpsProxyAgent(url);
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
}

interface SwarmConfig {
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  waitForProxiesReady: boolean;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  proxyTimeoutMs: number;
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
      pingIntervalMs: 2000,
      pingTimeoutMs: 5000,
      proxyTimeoutMs: 15000,
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
      for (const provider of providers) {
        this.providers.push(provider);
        provider.start({
          onReady: (config) => {
            const proxy = new Proxy(config);
            this.proxies.push(proxy);
          },
        });
      }
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
    console.log(`[ProxySwarm] ${message}`, ...args);
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
            this.log(`${proxy.host} is ready`);
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
        await new Promise(resolve => setTimeout(resolve, this.config.pingIntervalMs - elapsed));
      }
    }
  }

  async run(
    urls: string[],
    handler: (proxy: Proxy, url: string, res: Response) => Promise<void> | void,
    errorHandler: (proxy: Proxy, url: string, error: unknown) => Promise<void> | void,
  ): Promise<void> {
    if (!this.proxies.length) {
      await sleep(this.config.pingIntervalMs);
      return this.run(urls, handler, errorHandler);
    }
    if (this.config.waitForProxiesReady && this.runningProxies.size !== this.proxies.length) {
      this.log(`Waiting for proxies to be ready (${this.runningProxies.size}/${this.proxies.length})`);
      await sleep(this.config.pingIntervalMs);
      return this.run(urls, handler, errorHandler);
    }

    this.urlQueue.push(...urls);

    const timer = new Timer({
      alpha: 0.18,
      ema: 0,
      startTime: Date.now(),
      totalItems: urls.length,
      itemsProcessed: 0,
    });

    const workers = this.proxies.map(proxy => this.runWorker(proxy, handler, errorHandler, timer));

    this.log("workers", workers);

    await Promise.all(workers);

    this.log("all workers done");
  }

  async runWorker(
    proxy: Proxy,
    handler: (proxy: Proxy, url: string, res: Response) => Promise<void> | void,
    errorHandler: (proxy: Proxy, url: string, error: unknown) => Promise<void> | void,
    timer: Timer,
  ): Promise<void> {
    while (true) {
      const url = this.urlQueue[this.currentIndex++];
      if (!url) {
        break;
      }

      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.proxyTimeoutMs);
      const requestConfig: RequestInit = {
        method: "GET",
        headers: this.defaultHeaders,
        dispatcher: proxy.agent as unknown as ProxyAgent,
        signal: controller.signal,
      };

      try {
        const res = await fetch(url, requestConfig);
        await handler(proxy, url, res);
        this.logInfo(true, proxy, url, startTime, timer);
      }
      catch (error) {
        await errorHandler(proxy, url, error);
        this.logInfo(false, proxy, url, startTime, timer);
      }
      finally {
        clearTimeout(timeout);
      }
    }
  }

  private logInfo(
    success: boolean,
    proxy: Proxy,
    url: string,
    startTime: number,
    timer: Timer,
  ): void {
    const { elapsed, eta, remaining } = timer.tick(startTime, this.proxies.length);
    const trimmedUrl = url.length > 44 ? `${url.slice(0, 44)}...` : url;
    const infoStr = [trimmedUrl.padEnd(48, " "), elapsed, eta, remaining, proxy.host].join(
      " | ",
    );
    this.log(success ? infoStr : infoStr.red);
  }

  private async cleanup(): Promise<void> {
    this.log("Cleaning up...");
    for (const provider of this.providers) {
      await provider.stop();
    }
    process.exit(0);
  }
}

export default ProxySwarm;
