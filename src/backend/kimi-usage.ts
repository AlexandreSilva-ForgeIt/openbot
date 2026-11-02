// The Kimi Code plan usage, read from the endpoint that Kimi Code CLI serves with its own sign-in.
//
// Kimi's ACP process does not report quota. The CLI reads this endpoint for `/usage` with the access
// token in its credentials file. OpenBot reads only that token. It does not refresh a token or write
// a Kimi file. Both response shapes seen from the endpoint are accepted: legacy counters and ratio
// windows. Legacy counters win when both shapes report the same window.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { Effect, Option, Schema } from "effect";
import { type AccountRateLimitsReadResult, type AccountRateLimitWindowResult, getRecord } from "./protocol";

const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_USAGE_TIMEOUT_MS = 10_000;
const KIMI_REFRESH_WAIT_MS = 5_000;
const KIMI_REFRESH_POLL_MS = 100;
const KIMI_REFRESH_SAFETY_SECONDS = 300;
const KIMI_CREDENTIAL_MAX_BYTES = 64 * 1_024;
const KIMI_RESPONSE_MAX_BYTES = 64 * 1_024;
const FIVE_HOUR_MINS = 300;
const WEEKLY_MINS = 10_080;
const MONTHLY_MINS = 43_200;

const NO_USAGE: AccountRateLimitsReadResult = { rateLimits: null, rateLimitsByLimitId: null };

/** A safe adapter failure. Its cause never contains a credential or a response body. */
class KimiUsageFailed extends Schema.TaggedError<KimiUsageFailed>()("KimiUsageFailed", {
  cause: Schema.Defect(),
}) {}

const KimiCredential = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_at: Schema.optional(Schema.Unknown),
});

interface KimiSignIn {
  accessToken: string;
  expiresAt: number | null;
}

/** The file where the managed Kimi Code CLI keeps its OAuth credential. */
export function kimiCredentialsFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const shareDirectory = env.KIMI_SHARE_DIR?.trim() || join(home, ".kimi");
  return join(shareDirectory, "credentials", "kimi-code.json");
}

/** The Kimi Code quota for the CLI sign-in in `env`. */
export const readKimiUsage = Effect.fn("Kimi.readUsage")(function* (env: NodeJS.ProcessEnv = process.env) {
  const credential = yield* readCredential(env);
  if (!credential) return NO_USAGE;
  const endpoint = yield* Effect.try({
    try: () => usageEndpoint(env),
    catch: (cause) => new KimiUsageFailed({ cause }),
  });
  let payload = yield* fetchUsage(endpoint, credential.accessToken);
  if (payload === null && tokenCanRefresh(credential)) {
    const refreshed = yield* waitForCredentialChange(env, credential.accessToken);
    if (refreshed) payload = yield* fetchUsage(endpoint, refreshed);
  }
  return payload === null ? NO_USAGE : kimiRateLimits(payload);
});

const readCredential = Effect.fn("Kimi.readCredential")(function* (env: NodeJS.ProcessEnv) {
  const path = kimiCredentialsFile(env);
  const credential = yield* Effect.tryPromise({
    try: async () => {
      const details = await stat(path);
      if (!details.isFile() || details.size > KIMI_CREDENTIAL_MAX_BYTES) return null;
      return await readFile(path, "utf8");
    },
    catch: (cause) => new KimiUsageFailed({ cause }),
  }).pipe(Effect.option);
  if (Option.isNone(credential) || credential.value === null) return null;
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(KimiCredential))(credential.value);
  return Option.isSome(decoded)
    ? { accessToken: decoded.value.access_token, expiresAt: numeric(decoded.value.expires_at) }
    : null;
});

function tokenCanRefresh(credential: KimiSignIn): boolean {
  return (
    credential.expiresAt === null ||
    credential.expiresAt === 0 ||
    credential.expiresAt <= Date.now() / 1_000 + KIMI_REFRESH_SAFETY_SECONDS
  );
}

/**
 * A Kimi ACP session refreshes an old token in a background task when it starts. Wait for that task
 * to replace the credential, then retry once. OpenBot does not use or write the refresh token.
 */
const waitForCredentialChange = Effect.fn("Kimi.waitForCredentialChange")(function* (
  env: NodeJS.ProcessEnv,
  previousAccessToken: string,
) {
  const deadline = Date.now() + KIMI_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const credential = yield* readCredential(env);
    if (credential && credential.accessToken !== previousAccessToken) return credential.accessToken;
    yield* Effect.sleep(KIMI_REFRESH_POLL_MS);
  }
  return null;
});

function usageEndpoint(env: NodeJS.ProcessEnv): string {
  const value = env.KIMI_CODE_BASE_URL?.trim() || KIMI_CODE_BASE_URL;
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Kimi Code usage needs an HTTPS endpoint without credentials, a query, or a fragment.");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/usages`;
  return endpoint.href;
}

/** The endpoint answer, or null when it rejects the token. */
const fetchUsage = Effect.fn("Kimi.fetchUsage")(function* (endpoint: string, accessToken: string) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(endpoint, {
              headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
              redirect: "error",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(KIMI_USAGE_TIMEOUT_MS)]),
            }),
          catch: (cause) => new KimiUsageFailed({ cause }),
        });
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) {
          return yield* new KimiUsageFailed({
            cause: new Error(`Kimi Code usage returned HTTP ${response.status}.`),
          });
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > KIMI_RESPONSE_MAX_BYTES) {
          return yield* new KimiUsageFailed({ cause: new Error("Kimi Code usage returned too much data.") });
        }
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new KimiUsageFailed({ cause }),
        });
        if (Buffer.byteLength(text, "utf8") > KIMI_RESPONSE_MAX_BYTES) {
          return yield* new KimiUsageFailed({ cause: new Error("Kimi Code usage returned too much data.") });
        }
        return yield* Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: (cause) => new KimiUsageFailed({ cause }),
        });
      }),
    (controller) => Effect.sync(() => controller.abort()),
  );
});

function kimiRateLimits(value: unknown): AccountRateLimitsReadResult {
  const legacy = legacyWindows(value);
  const canonical = canonicalWindows(value);
  const primary = legacy.fiveHour ?? canonical.fiveHour;
  const weekly = legacy.weekly ?? canonical.weekly;
  const secondary = bindingLongWindow(weekly, canonical.monthly);
  if (!primary && !secondary) return NO_USAGE;
  return {
    rateLimits: { limitId: "kimi", primary, secondary },
    rateLimitsByLimitId: null,
  };
}

function legacyWindows(value: unknown): {
  fiveHour: AccountRateLimitWindowResult | null;
  weekly: AccountRateLimitWindowResult | null;
} {
  const weekly = counterWindow(getRecord(value, "usage"), WEEKLY_MINS);
  const rawLimits = isDynamicRecord(value) && Array.isArray(value.limits) ? value.limits : [];
  const windows = rawLimits.flatMap((item) => {
    if (!isDynamicRecord(item)) return [];
    const detail = getRecord(item, "detail") ?? item;
    const duration = durationMins(getRecord(item, "window") ?? item);
    const window = duration === null ? null : counterWindow(detail, duration);
    return window ? [window] : [];
  });
  const fiveHour = windows.find((window) => window.windowDurationMins === FIVE_HOUR_MINS) ?? null;
  return { fiveHour, weekly };
}

function canonicalWindows(value: unknown): {
  fiveHour: AccountRateLimitWindowResult | null;
  weekly: AccountRateLimitWindowResult | null;
  monthly: AccountRateLimitWindowResult | null;
} {
  const usages = getRecord(value, "usages");
  return {
    fiveHour: ratioWindow(getRecord(usages, "limit_5h"), FIVE_HOUR_MINS),
    weekly: ratioWindow(getRecord(usages, "limit_7d"), WEEKLY_MINS),
    monthly: ratioWindow(getRecord(usages, "limit_month_total"), MONTHLY_MINS),
  };
}

function counterWindow(
  value: ReturnType<typeof getRecord>,
  windowDurationMins: number,
): AccountRateLimitWindowResult | null {
  if (!value) return null;
  const limit = numeric(value.limit);
  const used = numeric(value.used) ?? (limit !== null ? difference(limit, numeric(value.remaining)) : null);
  if (limit === null || limit <= 0 || used === null) return null;
  return {
    usedPercent: clampPercent((used / limit) * 100),
    windowDurationMins,
    resetsAt: resetTime(value),
  };
}

function ratioWindow(
  value: ReturnType<typeof getRecord>,
  windowDurationMins: number,
): AccountRateLimitWindowResult | null {
  if (!value) return null;
  const ratio = numeric(value.used_ratio) ?? numeric(value.usedRatio);
  if (ratio === null) return null;
  return {
    usedPercent: clampPercent(ratio * 100),
    windowDurationMins,
    resetsAt: resetTime(value),
  };
}

function bindingLongWindow(
  weekly: AccountRateLimitWindowResult | null,
  monthly: AccountRateLimitWindowResult | null,
): AccountRateLimitWindowResult | null {
  if (!weekly || !monthly) return weekly ?? monthly;
  const weeklyUsed = weekly.usedPercent ?? 0;
  const monthlyUsed = monthly.usedPercent ?? 0;
  if (weeklyUsed >= 100 && monthlyUsed >= 100) {
    return (monthly.resetsAt ?? Number.POSITIVE_INFINITY) > (weekly.resetsAt ?? Number.POSITIVE_INFINITY)
      ? monthly
      : weekly;
  }
  return monthlyUsed > weeklyUsed ? monthly : weekly;
}

function durationMins(value: ReturnType<typeof getRecord>): number | null {
  if (!value) return null;
  const duration = numeric(value.duration);
  if (duration === null || duration <= 0) return null;
  const unit = isString(value.timeUnit) ? value.timeUnit.toUpperCase() : "";
  const minutes = unit.includes("MINUTE")
    ? duration
    : unit.includes("HOUR")
      ? duration * 60
      : unit.includes("DAY")
        ? duration * 1_440
        : unit.includes("SECOND")
          ? duration / 60
          : null;
  return minutes === null ? null : Math.round(minutes);
}

function resetTime(value: ReturnType<typeof getRecord>): number | null {
  if (!value) return null;
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const timestamp = value[key];
    if (!isString(timestamp)) continue;
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed / 1_000;
  }
  return null;
}

function numeric(value: unknown): number | null {
  const number = isNumber(value) ? value : isString(value) && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function difference(limit: number, remaining: number | null): number | null {
  return remaining === null ? null : limit - remaining;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
