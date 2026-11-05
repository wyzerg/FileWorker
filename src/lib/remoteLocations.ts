import type { ConnectionProfile } from "./types";

const prefix = "fileworker.remote.last-path.v1:";
type Location = { endpoint: [string, number, string]; path: string };
const endpoint = (profile: ConnectionProfile) => [profile.host.toLowerCase(), profile.port, profile.username] as const;
const validPath = (path: string) => path.startsWith("/") && path.length <= 32_768 && !/[\u0000-\u001f\u007f]/u.test(path);

function parse(value: string): Location | null {
  const item: unknown = JSON.parse(value);
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { endpoint, path } = item as Partial<Location>;
  return Array.isArray(endpoint) && endpoint.length === 3
    && typeof endpoint[0] === "string" && typeof endpoint[1] === "number" && typeof endpoint[2] === "string"
    && typeof path === "string" && validPath(path)
    ? { endpoint, path } : null;
}

export function readRemoteLocation(profile: ConnectionProfile): string | null {
  try {
    const value = localStorage.getItem(prefix + profile.id);
    const saved = value ? parse(value) : null;
    return saved && JSON.stringify(saved.endpoint) === JSON.stringify(endpoint(profile)) ? saved.path : null;
  } catch { return null; }
}

export function rememberRemoteLocation(profile: ConnectionProfile, path: string) {
  try {
    const key = prefix + profile.id;
    const previous = localStorage.getItem(key);
    // Preserve malformed data for inspection instead of silently replacing it.
    if (previous && !parse(previous)) return;
    if (!validPath(path)) return;
    localStorage.setItem(key, JSON.stringify({ endpoint: endpoint(profile), path }));
  } catch { /* Navigation remains usable without browser storage. */ }
}

export function forgetRemoteLocation(id: string) {
  try { localStorage.removeItem(prefix + id); } catch { /* Storage may be unavailable. */ }
}
