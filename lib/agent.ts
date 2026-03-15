import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import type { Duplex, Readable } from "node:stream";
import assert from "node:assert";
import * as http from "node:http";
import { Agent as HttpsAgent } from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { URL } from "node:url";

function debug(message: string) {
  if (process.env.LOG_LEVEL === "debug") {
    console.log(`Debug: ${message}`);
  }
}

interface HttpConnectOpts extends net.TcpNetConnectOpts {
  secureEndpoint: false;
  protocol?: string;
}

interface HttpsConnectOpts extends tls.ConnectionOptions {
  secureEndpoint: true;
  protocol?: string;
  port: number;
}

export type AgentConnectOpts = HttpConnectOpts | HttpsConnectOpts;

const INTERNAL = Symbol("AgentBaseInternalState");

interface InternalState {
  defaultPort?: number;
  protocol?: string;
  currentSocket?: Duplex;
}

export abstract class Agent extends http.Agent {
  private [INTERNAL]: InternalState;

  options: Partial<net.TcpNetConnectOpts & tls.ConnectionOptions>;
  keepAlive: boolean;

  constructor(opts?: http.AgentOptions) {
    super(opts);
    this[INTERNAL] = {};
  }

  abstract connect(
    req: http.ClientRequest,
    options: AgentConnectOpts
  ): Promise<Duplex | http.Agent> | Duplex | http.Agent;

  /**
   * Determine whether this is an `http` or `https` request.
   */
  isSecureEndpoint(options?: AgentConnectOpts): boolean {
    if (options) {
      // First check the `secureEndpoint` property explicitly, since this
      // means that a parent `Agent` is "passing through" to this instance.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (options as any).secureEndpoint === "boolean") {
        return options.secureEndpoint;
      }

      // If no explicit `secure` endpoint, check if `protocol` property is
      // set. This will usually be the case since using a full string URL
      // or `URL` instance should be the most common usage.
      if (typeof options.protocol === "string") {
        return options.protocol === "https:";
      }
    }

    // Finally, if no `protocol` property was set, then fall back to
    // checking the stack trace of the current call stack, and try to
    // detect the "https" module.
    const { stack } = new Error();
    if (typeof stack !== "string")
      return false;
    return stack
      .split("\n")
      .some(
        l =>
          l.includes("(https.js:")
          || l.includes("node:https:"),
      );
  }

  // In order to support async signatures in `connect()` and Node's native
  // connection pooling in `http.Agent`, the array of sockets for each origin
  // has to be updated synchronously. This is so the length of the array is
  // accurate when `addRequest()` is next called. We achieve this by creating a
  // fake socket and adding it to `sockets[origin]` and incrementing
  // `totalSocketCount`.
  private incrementSockets(name: string) {
    // If `maxSockets` and `maxTotalSockets` are both Infinity then there is no
    // need to create a fake socket because Node.js native connection pooling
    // will never be invoked.
    if (this.maxSockets === Infinity && this.maxTotalSockets === Infinity) {
      return null;
    }
    // All instances of `sockets` are expected TypeScript errors. The
    // alternative is to add it as a private property of this class but that
    // will break TypeScript subclassing.
    if (!this.sockets[name]) {
      // @ts-expect-error `sockets` is readonly in `@types/node`
      this.sockets[name] = [];
    }
    const fakeSocket = new net.Socket({ writable: false });
    (this.sockets[name] as net.Socket[]).push(fakeSocket);
    // @ts-expect-error `totalSocketCount` isn't defined in `@types/node`
    this.totalSocketCount++;
    return fakeSocket;
  }

  private decrementSockets(name: string, socket: null | net.Socket) {
    if (!this.sockets[name] || socket === null) {
      return;
    }
    const sockets = this.sockets[name] as net.Socket[];
    const index = sockets.indexOf(socket);
    if (index !== -1) {
      sockets.splice(index, 1);
      // @ts-expect-error  `totalSocketCount` isn't defined in `@types/node`
      this.totalSocketCount--;
      if (sockets.length === 0) {
        // @ts-expect-error `sockets` is readonly in `@types/node`
        delete this.sockets[name];
      }
    }
  }

  // In order to properly update the socket pool, we need to call `getName()` on
  // the core `https.Agent` if it is a secureEndpoint.
  getName(options?: AgentConnectOpts): string {
    const secureEndpoint = this.isSecureEndpoint(options);
    if (secureEndpoint) {
      return HttpsAgent.prototype.getName.call(this, options);
    }
    return super.getName(options);
  }

  createSocket(
    req: http.ClientRequest,
    options: AgentConnectOpts,
    cb: (err: Error | null, s?: Duplex) => void,
  ) {
    const connectOpts = {
      ...options,
      secureEndpoint: this.isSecureEndpoint(options),
    };
    const name = this.getName(connectOpts);
    const fakeSocket = this.incrementSockets(name);
    Promise.resolve()
      .then(() => this.connect(req, connectOpts))
      .then(
        (socket) => {
          this.decrementSockets(name, fakeSocket);
          if (socket instanceof http.Agent) {
            try {
              // @ts-expect-error `addRequest()` isn't defined in `@types/node`
              return socket.addRequest(req, connectOpts);
            }
            catch (err: unknown) {
              return cb(err as Error);
            }
          }
          this[INTERNAL].currentSocket = socket;
          // @ts-expect-error `createSocket()` isn't defined in `@types/node`
          super.createSocket(req, options, cb);
        },
        (err) => {
          this.decrementSockets(name, fakeSocket);
          cb(err);
        },
      );
  }

  createConnection(): Duplex {
    const socket = this[INTERNAL].currentSocket;
    this[INTERNAL].currentSocket = undefined;
    if (!socket) {
      throw new Error(
        "No socket was returned in the `connect()` function",
      );
    }
    return socket;
  }

  get defaultPort(): number {
    return (
      this[INTERNAL].defaultPort
      ?? (this.protocol === "https:" ? 443 : 80)
    );
  }

  set defaultPort(v: number) {
    if (this[INTERNAL]) {
      this[INTERNAL].defaultPort = v;
    }
  }

  get protocol(): string {
    return (
      this[INTERNAL].protocol
      ?? (this.isSecureEndpoint() ? "https:" : "http:")
    );
  }

  set protocol(v: string) {
    if (this[INTERNAL]) {
      this[INTERNAL].protocol = v;
    }
  }
}

function setServernameFromNonIpHost<
  T extends { host?: string; servername?: string },
>(options: T) {
  if (
    options.servername === undefined
    && options.host
    && !net.isIP(options.host)
  ) {
    return {
      ...options,
      servername: options.host,
    };
  }
  return options;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Protocol<T> = T extends `${infer Protocol}:${infer _}` ? Protocol : never;

interface ConnectOptsMap {
  http: Omit<net.TcpNetConnectOpts, "host" | "port">;
  https: Omit<tls.ConnectionOptions, "host" | "port">;
}

type ConnectOpts<T> = {
  [P in keyof ConnectOptsMap]: Protocol<T> extends P
    ? ConnectOptsMap[P]
    : never;
}[keyof ConnectOptsMap];

export type HttpsProxyAgentOptions<T> = ConnectOpts<T>
  & http.AgentOptions & {
    headers?: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
  };

/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to
 * the specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * Outgoing HTTP requests are first tunneled through the proxy server using the
 * `CONNECT` HTTP request method to establish a connection to the proxy server,
 * and then the proxy server connects to the destination target and issues the
 * HTTP request from the proxy server.
 *
 * `https:` requests have their socket connection upgraded to TLS once
 * the connection to the proxy server has been established.
 */
export class HttpsProxyAgent<Uri extends string> extends Agent {
  static protocols = ["http", "https"] as const;

  readonly proxy: URL;
  proxyHeaders: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
  connectOpts: net.TcpNetConnectOpts & tls.ConnectionOptions;

  constructor(proxy: Uri | URL, opts?: HttpsProxyAgentOptions<Uri>) {
    super(opts);
    this.options = { path: undefined };
    this.proxy = typeof proxy === "string" ? new URL(proxy) : proxy;
    this.proxyHeaders = opts?.headers ?? {};
    debug(`Creating new HttpsProxyAgent instance: ${this.proxy.href}`);

    // Trim off the brackets from IPv6 addresses
    const host = (this.proxy.hostname || this.proxy.host).replace(
      /^\[|\]$/g,
      "",
    );
    const port = this.proxy.port
      ? Number.parseInt(this.proxy.port, 10)
      : this.proxy.protocol === "https:"
        ? 443
        : 80;
    this.connectOpts = {
      // Attempt to negotiate http/1.1 for proxy servers that support http/2
      ALPNProtocols: ["http/1.1"],
      ...(opts ? omit(opts, "headers") : null),
      host,
      port,
    };
  }

  /**
   * Called when the node-core HTTP client library is creating a
   * new HTTP request.
   */
  async connect(
    req: http.ClientRequest,
    opts: AgentConnectOpts,
  ): Promise<net.Socket> {
    const { proxy } = this;

    if (!opts.host) {
      throw new TypeError("No \"host\" provided");
    }

    // Create a socket connection to the proxy server.
    let socket: net.Socket;
    if (proxy.protocol === "https:") {
      debug(`Creating tls.Socket: ${this.connectOpts}`);
      socket = tls.connect(setServernameFromNonIpHost(this.connectOpts));
    }
    else {
      debug(`Creating net.Socket: ${this.connectOpts}`);
      socket = net.connect(this.connectOpts);
    }

    const headers: OutgoingHttpHeaders
      = typeof this.proxyHeaders === "function"
        ? this.proxyHeaders()
        : { ...this.proxyHeaders };
    const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
    let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;

    // Inject the `Proxy-Authorization` header if necessary.
    if (proxy.username || proxy.password) {
      const auth = `${decodeURIComponent(
        proxy.username,
      )}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(
        auth,
      ).toString("base64")}`;
    }

    headers.Host = `${host}:${opts.port}`;

    if (!headers["Proxy-Connection"]) {
      headers["Proxy-Connection"] = this.keepAlive
        ? "Keep-Alive"
        : "close";
    }
    for (const name of Object.keys(headers)) {
      payload += `${name}: ${headers[name]}\r\n`;
    }

    const proxyResponsePromise = parseProxyResponse(socket);

    socket.write(`${payload}\r\n`);

    const { connect, buffered } = await proxyResponsePromise;
    req.emit("proxyConnect", connect);
    this.emit("proxyConnect", connect, req);

    if (connect.statusCode === 200) {
      req.once("socket", resume);

      if (opts.secureEndpoint) {
        // The proxy is connecting to a TLS server, so upgrade
        // this socket connection to a TLS connection.
        debug("Upgrading socket connection to TLS");
        return tls.connect({
          ...omit(
            setServernameFromNonIpHost(opts),
            "host",
            "path",
            "port",
          ),
          socket,
        });
      }

      return socket;
    }

    // Some other status code that's not 200... need to re-play the HTTP
    // header "data" events onto the socket once the HTTP machinery is
    // attached so that the node core `http` can parse and handle the
    // error status code.

    // Close the original socket, and a new "fake" socket is returned
    // instead, so that the proxy doesn't get the HTTP request
    // written to it (which may contain `Authorization` headers or other
    // sensitive data).
    //
    // See: https://hackerone.com/reports/541502
    socket.destroy();

    const fakeSocket = new net.Socket({ writable: false });
    fakeSocket.readable = true;

    // Need to wait for the "socket" event to re-play the "data" events.
    req.once("socket", (s: net.Socket) => {
      debug("Replaying proxy buffer for failed request");
      assert(s.listenerCount("data") > 0);

      // Replay the "buffered" Buffer onto the fake `socket`, since at
      // this point the HTTP module machinery has been hooked up for
      // the user.
      s.push(buffered);
      s.push(null);
    });

    return fakeSocket;
  }
}

function resume(socket: net.Socket | tls.TLSSocket): void {
  socket.resume();
}

function omit<T extends object, K extends [...(keyof T)[]]>(
  obj: T,
  ...keys: K
): {
  [K2 in Exclude<keyof T, K[number]>]: T[K2];
} {
  const ret = {} as {
    [K in keyof typeof obj]: (typeof obj)[K];
  };
  let key: keyof typeof obj;
  for (key in obj) {
    if (!keys.includes(key)) {
      ret[key] = obj[key];
    }
  }
  return ret;
}

interface ConnectResponse {
  statusCode: number;
  statusText: string;
  headers: IncomingHttpHeaders;
}

function parseProxyResponse(
  socket: Readable,
): Promise<{ connect: ConnectResponse; buffered: Buffer }> {
  return new Promise((resolve, reject) => {
    // we need to buffer any HTTP traffic that happens with the proxy before we get
    // the CONNECT response, so that if the response is anything other than an "200"
    // response code, then we can re-play the "data" events on the socket once the
    // HTTP parser is hooked up...
    let buffersLength = 0;
    const buffers: Buffer[] = [];

    function read() {
      const b = socket.read();
      if (b)
        ondata(b);
      else socket.once("readable", read);
    }

    function cleanup() {
      socket.removeListener("end", onend);
      socket.removeListener("error", onerror);
      socket.removeListener("readable", read);
    }

    function onend() {
      cleanup();
      debug("onend");
      reject(
        new Error(
          "Proxy connection ended before receiving CONNECT response",
        ),
      );
    }

    function onerror(err: Error) {
      cleanup();
      debug(`onerror ${err}`);
      reject(err);
    }

    function ondata(b: Buffer) {
      buffers.push(b);
      buffersLength += b.length;

      const buffered = Buffer.concat(buffers, buffersLength);
      const endOfHeaders = buffered.indexOf("\r\n\r\n");

      if (endOfHeaders === -1) {
        // keep buffering
        debug("have not received end of HTTP headers yet...");
        read();
        return;
      }

      const headerParts = buffered
        .slice(0, endOfHeaders)
        .toString("ascii")
        .split("\r\n");
      const firstLine = headerParts.shift();
      if (!firstLine) {
        socket.destroy();
        return reject(
          new Error("No header received from proxy CONNECT response"),
        );
      }
      const firstLineParts = firstLine.split(" ");
      const statusCode = +firstLineParts[1];
      const statusText = firstLineParts.slice(2).join(" ");
      const headers: IncomingHttpHeaders = {};
      for (const header of headerParts) {
        if (!header)
          continue;
        const firstColon = header.indexOf(":");
        if (firstColon === -1) {
          socket.destroy();
          return reject(
            new Error(
              `Invalid header from proxy CONNECT response: "${header}"`,
            ),
          );
        }
        const key = header.slice(0, firstColon).toLowerCase();
        const value = header.slice(firstColon + 1).trimStart();
        const current = headers[key];
        if (typeof current === "string") {
          headers[key] = [current, value];
        }
        else if (Array.isArray(current)) {
          current.push(value);
        }
        else {
          headers[key] = value;
        }
      }
      debug(`got proxy server response: ${firstLine} ${headers}`);
      cleanup();
      resolve({
        connect: {
          statusCode,
          statusText,
          headers,
        },
        buffered,
      });
    }

    socket.on("error", onerror);
    socket.on("end", onend);

    read();
  });
}
