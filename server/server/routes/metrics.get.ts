import { defineEventHandler, setHeader } from "h3";
import { collectMetricsSnapshot, renderPrometheusMetrics } from "#app/utils/metrics";

export default defineEventHandler(async (event) => {
  const snapshot = await collectMetricsSnapshot();
  setHeader(event, "content-type", "text/plain; version=0.0.4; charset=utf-8");
  return `${renderPrometheusMetrics(snapshot)}\n`;
});
