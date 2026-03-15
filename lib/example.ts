import type { Proxy } from "./swarm";
import process from "node:process";
import { AwsProxyProvider } from "./aws";
import Swarm from "./swarm";

const awsProvider = new AwsProxyProvider(
  {
    proxyPort: 8001,
    proxyUsername: "username",
    proxyPassword: "password",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    instanceCount: 5,
  },
);

const swarm = new Swarm({
  providers: [awsProvider],
});

const urls = [
  "https://google.com",
  "https://facebook.com",
  "https://amazon.com",
  "https://myspace.com",
  "https://airbnb.com",
];

function onSuccess(proxy: Proxy, url: string, res: Response) {
  // todo
}

function onError(proxy: Proxy, url: string, error: unknown) {
  console.error(error);
}

await swarm.run(urls, onSuccess, onError);
