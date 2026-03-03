export function makeConflictPath(path: string, deviceId: string, ts: number) {
  return `${path}.conflict.${deviceId}.${ts}.md`;
}
