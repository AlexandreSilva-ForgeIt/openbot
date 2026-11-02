// Reads Kimi Code quota end to end with the credential and environment that the managed Kimi CLI
// uses. A fake Kimi ACP process and a fake `fetch` replace the provider. The check covers the legacy
// counter response, the ratio response, malformed or rejected credentials, the provider driver,
// normalization, and the shared usage-row model used by desktop and web.
// `bun scripts/kimi-usage-e2e.ts`. Writes .openbot-build/kimi-usage-e2e/report.json.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { agentProviderDescriptor, isAccountUsage } from "@openbot/contracts/ipc";
import { normalizeAccountUsage } from "../src/backend/agent/account-usage";
import type { AgentClient } from "../src/backend/agent-client";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { kimiCredentialsFile, readKimiUsage } from "../src/backend/kimi-usage";
import { type AccountRateLimitsReadResult, decodeAccountRateLimitsReadResult } from "../src/backend/protocol";
import { NO_PROVIDER_CREDENTIALS, requireProviderDriver } from "../src/backend/provider-drivers";

const OUT = resolve(import.meta.dirname, "../.openbot-build/kimi-usage-e2e");
const FAKE_TOKEN = "fake-kimi-access-token";
const REFRESHED_TOKEN = "fake-kimi-refreshed-access-token";
const API_BASE = "https://api.kimi.test/coding/v1";
const USAGE_URL = `${API_BASE}/usages`;
const FIVE_HOUR_RESET = "2026-11-03T02:00:00.000Z";
const WEEKLY_RESET = "2026-11-08T00:00:00.000Z";
const MONTHLY_RESET = "2026-12-01T00:00:00.000Z";
const NO_USAGE = { rateLimits: null, rateLimitsByLimitId: null };

interface UsageRequest {
  url: string;
  authorized: boolean;
  redirect: RequestRedirect | undefined;
}

interface UsageCase {
  reading: AccountRateLimitsReadResult;
  requests: UsageRequest[];
}

interface Report {
  passed: boolean;
  legacy?: UsageCase;
  canonical?: UsageCase;
  mixed?: UsageCase;
  refreshedCredential?: UsageCase;
  rejected?: UsageCase;
  missingCredential?: UsageCase;
  malformedCredential?: UsageCase;
  malformedResponse?: UsageCase;
  unsafeEndpointRejected?: boolean;
  driver?: {
    reading: AccountRateLimitsReadResult;
    normalized: ReturnType<typeof normalizeAccountUsage>;
    descriptor: { provider: string; reportsUsage: boolean; windowCount: number };
  };
}

const LEGACY_PAYLOAD = {
  usage: { limit: "1000", used: "250", remaining: "750", resetTime: WEEKLY_RESET },
  limits: [
    {
      window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "12", resetTime: FIVE_HOUR_RESET },
    },
  ],
};
const CANONICAL_PAYLOAD = {
  goods_version: 2,
  usages: {
    limit_5h: { used_ratio: "0.12", reset_time: FIVE_HOUR_RESET },
    limit_7d: { used_ratio: 0.55, reset_time: WEEKLY_RESET },
    limit_month_total: { used_ratio: 0.7, reset_time: MONTHLY_RESET },
    limit_month_code: { used_ratio: 0.4, reset_time: MONTHLY_RESET },
  },
};

const root = await mkdtemp(join(tmpdir(), "openbot-kimi-usage-e2e-"));
const shareDir = join(root, "kimi");
const executable = join(root, "runtime", "kimi");
const report: Report = { passed: false };
const clients: AgentClient[] = [];
const realFetch = globalThis.fetch;
let answer: { status: number; body: unknown } = { status: 200, body: LEGACY_PAYLOAD };
let answerRequest = async (_accessToken: string): Promise<{ status: number; body: unknown }> => answer;
let requests: UsageRequest[] = [];

globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== USAGE_URL) throw new Error(`Unexpected request to ${url}.`);
    const accessToken = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
    requests.push({
      url,
      authorized: Boolean(accessToken),
      redirect: init?.redirect,
    });
    const response = await answerRequest(accessToken);
    return Response.json(response.body, { status: response.status });
  },
  { preconnect: realFetch.preconnect },
);

const FAKE_KIMI = `#!/usr/bin/env node
const NL = String.fromCharCode(10);
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + NL);
function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (message.method === "session/new") {
    write({ id: message.id, result: {
      sessionId: "s-" + message.id,
      models: { availableModels: [{ modelId: "kimi-fake", name: "Kimi Fake" }], currentModelId: "kimi-fake" },
    } });
    return;
  }
  write({ id: message.id, result: {} });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf(NL)) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
setInterval(() => {}, 1000);
`;

async function writeCredential(value: unknown): Promise<void> {
  const path = kimiCredentialsFile({ KIMI_SHARE_DIR: shareDir });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

async function readUsage(status: number, body: unknown): Promise<UsageCase> {
  answer = { status, body };
  answerRequest = async () => answer;
  requests = [];
  const reading = await runCauseEffect(readKimiUsage({ KIMI_SHARE_DIR: shareDir, KIMI_CODE_BASE_URL: API_BASE }));
  return { reading, requests };
}

const legacyReading = {
  limitId: "kimi",
  primary: {
    usedPercent: 88,
    windowDurationMins: 300,
    resetsAt: Date.parse(FIVE_HOUR_RESET) / 1_000,
  },
  secondary: {
    usedPercent: 25,
    windowDurationMins: 10_080,
    resetsAt: Date.parse(WEEKLY_RESET) / 1_000,
  },
};
const canonicalReading = {
  limitId: "kimi",
  primary: {
    usedPercent: 12,
    windowDurationMins: 300,
    resetsAt: Date.parse(FIVE_HOUR_RESET) / 1_000,
  },
  secondary: {
    usedPercent: 70,
    windowDurationMins: 43_200,
    resetsAt: Date.parse(MONTHLY_RESET) / 1_000,
  },
};

try {
  await writeCredential({
    access_token: FAKE_TOKEN,
    refresh_token: "not-read-by-openbot",
    expires_at: Date.now() / 1_000 + 3_600,
  });

  report.legacy = await readUsage(200, LEGACY_PAYLOAD);
  assert.deepEqual(report.legacy.reading.rateLimits, legacyReading);
  assert.deepEqual(report.legacy.requests, [{ url: USAGE_URL, authorized: true, redirect: "error" }]);

  report.canonical = await readUsage(200, CANONICAL_PAYLOAD);
  assert.deepEqual(report.canonical.reading.rateLimits, canonicalReading);

  report.mixed = await readUsage(200, {
    ...CANONICAL_PAYLOAD,
    usages: {
      ...CANONICAL_PAYLOAD.usages,
      limit_5h: { used_ratio: 0, reset_time: FIVE_HOUR_RESET },
      limit_7d: { used_ratio: 0, reset_time: WEEKLY_RESET },
      limit_month_total: { used_ratio: 0.1, reset_time: MONTHLY_RESET },
    },
    ...LEGACY_PAYLOAD,
  });
  assert.deepEqual(report.mixed.reading.rateLimits, legacyReading, "legacy counters win for the same windows");

  await writeCredential({ access_token: FAKE_TOKEN, expires_at: Date.now() / 1_000 - 60 });
  requests = [];
  answerRequest = async (accessToken) => {
    if (accessToken === REFRESHED_TOKEN) return { status: 200, body: LEGACY_PAYLOAD };
    await writeCredential({ access_token: REFRESHED_TOKEN, expires_at: Date.now() / 1_000 + 3_600 });
    return { status: 401, body: { error: "expired" } };
  };
  const refreshedReading = await runCauseEffect(
    readKimiUsage({ KIMI_SHARE_DIR: shareDir, KIMI_CODE_BASE_URL: API_BASE }),
  );
  report.refreshedCredential = { reading: refreshedReading, requests };
  assert.deepEqual(refreshedReading.rateLimits, legacyReading, "a token refreshed by Kimi is retried once");
  assert.equal(requests.length, 2);

  await writeCredential({
    access_token: FAKE_TOKEN,
    expires_at: Date.now() / 1_000 + 3_600,
  });

  report.rejected = await readUsage(401, { error: "unauthorized" });
  assert.deepEqual(report.rejected.reading, NO_USAGE);

  await rm(kimiCredentialsFile({ KIMI_SHARE_DIR: shareDir }));
  report.missingCredential = await readUsage(200, LEGACY_PAYLOAD);
  assert.deepEqual(report.missingCredential, { reading: NO_USAGE, requests: [] });

  await writeCredential({ access_token: "", refresh_token: FAKE_TOKEN });
  report.malformedCredential = await readUsage(200, LEGACY_PAYLOAD);
  assert.deepEqual(report.malformedCredential, { reading: NO_USAGE, requests: [] });

  await writeCredential({ access_token: FAKE_TOKEN });
  report.malformedResponse = await readUsage(200, { usage: { limit: "zero", used: [] }, limits: "wrong" });
  assert.deepEqual(report.malformedResponse.reading, NO_USAGE);

  requests = [];
  await assert.rejects(
    runCauseEffect(readKimiUsage({ KIMI_SHARE_DIR: shareDir, KIMI_CODE_BASE_URL: "http://api.kimi.test/coding/v1" })),
    /HTTPS endpoint/u,
  );
  assert.deepEqual(requests, [], "an unsafe endpoint receives no credential");
  report.unsafeEndpointRejected = true;

  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, FAKE_KIMI);
  await chmod(executable, 0o755);
  answer = { status: 200, body: LEGACY_PAYLOAD };
  requests = [];
  const context = {
    ...NO_PROVIDER_CREDENTIALS,
    agentEnvironment: () => ({ KIMI_SHARE_DIR: shareDir, KIMI_CODE_BASE_URL: API_BASE }),
  };
  const client = requireProviderDriver("kimi").createClient(
    { executable, version: "1.52.0", source: "managed" },
    10_000,
    context,
  );
  clients.push(client);
  client.start();
  const reading = await runCauseEffect(
    client.request("account/rateLimits/read", { model: "kimi-fake" }, decodeAccountRateLimitsReadResult),
  );
  const normalized = normalizeAccountUsage(reading);
  assert.equal(isAccountUsage(normalized), true, "the reading satisfies the released account-usage contract");
  const descriptor = agentProviderDescriptor("kimi");
  const limit = normalized.limits[0];
  assert.ok(limit);
  assert.equal(descriptor.reportsUsage, true, "the shared client descriptor enables the rail ring");
  const windowCount = [limit.primary, limit.secondary].filter(Boolean).length;
  assert.equal(windowCount, 2);
  report.driver = {
    reading,
    normalized,
    descriptor: { provider: descriptor.id, reportsUsage: descriptor.reportsUsage, windowCount },
  };

  report.passed = true;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(
    [FAKE_TOKEN, REFRESHED_TOKEN].some((token) => serialized.includes(token)),
    false,
    "the report does not contain a credential",
  );
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "report.json"), serialized);
  process.stdout.write(serialized);
} finally {
  globalThis.fetch = realFetch;
  for (const client of clients) await runCauseEffect(client.stop()).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
