import { JsonRpcProvider, WebSocketProvider } from "ethers";
import fs from "fs";

export function loadConfig() {
  const configPath = new URL("./config.json", import.meta.url).pathname;
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const rpcUrls = process.env.RPC_URLS
    ? process.env.RPC_URLS.split(",").map((s) => s.trim())
    : [process.env.RPC_URL];

  if (!rpcUrls || rpcUrls.length === 0 || rpcUrls[0] === undefined) {
    throw new Error("RPC_URL or RPC_URLS env var required");
  }

  const wsUrls = process.env.WS_URLS
    ? process.env.WS_URLS.split(",").map((s) => s.trim())
    : process.env.WS_URL
    ? [process.env.WS_URL]
    : null;

  return { ...cfg, rpcUrls, wsUrls };
}

export class RoundRobinProvider {
  constructor(urls) {
    this.urls = urls;
    this.providers = urls.map((u) => {
      const p = new JsonRpcProvider(u);
      p._rpcUrl = u;
      return p;
    });
    this.index = 0;
  }

  next() {
    const provider = this.providers[this.index % this.providers.length];
    this.index++;
    return provider;
  }

  get count() {
    return this.providers.length;
  }

  getUrl(i) {
    return this.urls[i % this.urls.length];
  }
}

export class RoundRobinWsProvider {
  constructor(urls) {
    this.urls = urls;
    this.providers = urls.map((u) => new WebSocketProvider(u));
    this.index = 0;
  }

  next() {
    const provider = this.providers[this.index % this.providers.length];
    this.index++;
    return provider;
  }

  get count() {
    return this.providers.length;
  }

  destroy() {
    for (const p of this.providers) {
      try { p.destroy(); } catch {}
    }
  }
}

export function logResult(results, entry) {
  results.push(entry);
}

export function saveResults(results, filename) {
  const outPath = new URL(`./results/${filename}`, import.meta.url);
  const dir = new URL("./results/", import.meta.url);
  if (!fs.existsSync(dir.pathname)) {
    fs.mkdirSync(dir.pathname, { recursive: true });
  }
  fs.writeFileSync(outPath.pathname, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${outPath.pathname} (${results.length} entries)`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runConcurrent({ count, intervalMs, submitFn, label }) {
  let sentCount = 0;
  let lastCount = 0;
  let seconds = 0;
  const startMs = Date.now();

  const logger = setInterval(() => {
    seconds++;
    const rate = sentCount - lastCount;
    console.log(`  [${label} ${seconds}s] sent: ${rate}/s, total: ${sentCount}/${count}`);
    lastCount = sentCount;
  }, 1000);

  const promises = [];
  for (let i = 0; i < count; i++) {
    sentCount++;
    const submitTs = Date.now();
    promises.push(submitFn(i, submitTs));

    const nextTarget = startMs + (i + 1) * intervalMs;
    const remaining = nextTarget - Date.now();
    if (remaining > 0 && i < count - 1) await sleep(remaining);
  }

  clearInterval(logger);
  const elapsedMs = Date.now() - startMs;
  console.log(`  [${label}] all ${count} sent in ${elapsedMs}ms`);

  return Promise.allSettled(promises);
}
