export function makeConflictPath(originalPath: string, deviceId: string, ts: number): string {
  const d = new Date(ts);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const short = deviceId.length > 8 ? deviceId.slice(-8) : deviceId;
  const lastDot = originalPath.lastIndexOf(".");
  const lastSlash = originalPath.lastIndexOf("/");
  if (lastDot > lastSlash + 1) {
    return `${originalPath.slice(0, lastDot)} (conflict ${short} ${date})${originalPath.slice(lastDot)}`;
  }
  return `${originalPath} (conflict ${short} ${date})`;
}
