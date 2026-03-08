import { defineEventHandler, getHeader, getRequestURL, type H3Event } from "h3";
import { hashApiKey } from "#app/utils/auth";
import { enforceRateLimit, getClientIp } from "#app/utils/rate-limit";

type RateLimitRule = {
  match: (event: H3Event, method: string, path: string) => boolean;
  scope: string;
  max: number;
  windowMs: number;
  message: string;
  resolveKey: (event: H3Event, ip: string) => string;
};

const RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    match: (_event, method, path) => method === "POST" && path === "/api/v1/device/register",
    scope: "device.register.ip",
    max: 10,
    windowMs: 10 * 60 * 1000,
    message: "Too many device registrations. Try again later.",
    resolveKey: (_event, ip) => ip
  },
  {
    match: (_event, method, path) => method === "POST" && path === "/api/v1/sync/push",
    scope: "sync.push.client",
    max: 120,
    windowMs: 60 * 1000,
    message: "Too many sync push requests. Try again later.",
    resolveKey: (event, ip) => {
      const token = getBearerToken(event);
      return token ? hashApiKey(token) : ip;
    }
  }
];

function getBearerToken(event: H3Event) {
  const header = String(getHeader(event, "authorization") || "");
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice("Bearer ".length).trim();
}

export default defineEventHandler((event) => {
  const reqId = String((event.context as Record<string, unknown>).requestId || "");
  const method = event.method.toUpperCase();
  const path = getRequestURL(event).pathname;
  const ip = getClientIp(event);
  for (const rule of RATE_LIMIT_RULES) {
    if (!rule.match(event, method, path)) {
      continue;
    }

    enforceRateLimit(event, {
      scope: rule.scope,
      key: rule.resolveKey(event, ip),
      max: rule.max,
      windowMs: rule.windowMs,
      message: rule.message,
      meta: { reqId, ip, path }
    });
    return;
  }
});
