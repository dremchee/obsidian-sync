export function normalizeSyncPath(path: string | null | undefined): string {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
}
