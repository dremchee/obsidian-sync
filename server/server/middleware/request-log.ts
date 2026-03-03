import { defineEventHandler, getRequestIP, getRequestURL } from "h3";
import { logByStatus, logDebug } from "#app/utils/logger";

export default defineEventHandler((event) => {
  const start = Date.now();
  const reqId = globalThis.crypto.randomUUID().slice(0, 8);
  (event.context as Record<string, unknown>).requestId = reqId;

  const method = event.method;
  const url = getRequestURL(event);
  const path = url.pathname;

  logDebug("request.start", {
    reqId,
    method,
    path
  });

  event.node.res.once("finish", () => {
    const durationMs = Date.now() - start;
    logByStatus("request.finish", event.node.res.statusCode, {
      reqId,
      method,
      path,
      statusCode: event.node.res.statusCode,
      durationMs,
      ip: getRequestIP(event, { xForwardedFor: true }),
      userAgent: event.node.req.headers["user-agent"] || "",
      authorization: event.node.req.headers.authorization || "",
      xApiKey: event.node.req.headers["x-api-key"] || ""
    });
  });
});
