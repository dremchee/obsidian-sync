import { defineEventHandler, setResponseStatus } from "h3";
import { collectHealthSnapshot } from "#app/utils/health";

export default defineEventHandler(async (event) => {
  const snapshot = await collectHealthSnapshot();
  setResponseStatus(event, snapshot.status === "fail" ? 503 : 200);
  return snapshot;
});
