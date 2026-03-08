import { createError, getRequestIP, type H3Event, setHeader } from "h3";
import { logWarn } from "#app/utils/logger";

type RateLimitOptions = {
  scope: string;
  key: string;
  max: number;
  windowMs: number;
  message?: string;
  meta?: Record<string, unknown>;
};

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function pruneExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function maybePruneBuckets(now: number) {
  if (buckets.size < MAX_BUCKETS) {
    return;
  }
  pruneExpiredBuckets(now);
}

export function getClientIp(event: H3Event) {
  return getRequestIP(event, { xForwardedFor: true }) || event.node.req.socket.remoteAddress || "unknown";
}

export function enforceRateLimit(event: H3Event, opts: RateLimitOptions) {
  const now = Date.now();
  maybePruneBuckets(now);

  const bucketKey = `${opts.scope}:${opts.key}`;
  const current = buckets.get(bucketKey);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + opts.windowMs }
    : current;

  if (bucket.count >= opts.max) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    setHeader(event, "Retry-After", String(retryAfterSec));
    setHeader(event, "X-RateLimit-Limit", String(opts.max));
    setHeader(event, "X-RateLimit-Remaining", "0");
    setHeader(event, "X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    logWarn("rate_limit.exceeded", {
      scope: opts.scope,
      key: opts.key,
      retryAfterSec,
      ...(opts.meta || {})
    });

    throw createError({
      statusCode: 429,
      statusMessage: opts.message || "Too many requests"
    });
  }

  bucket.count += 1;
  buckets.set(bucketKey, bucket);

  setHeader(event, "X-RateLimit-Limit", String(opts.max));
  setHeader(event, "X-RateLimit-Remaining", String(Math.max(0, opts.max - bucket.count)));
  setHeader(event, "X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
}
