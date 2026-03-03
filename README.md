# Obsidian Self-Hosted Sync (Nitro + SQLite + CAS)

Minimal v1 implementation of a custom Obsidian sync stack:
- Nitro backend (`server/`)
- SQLite metadata/version history (`data/app.db`)
- CAS blob store (`data/blobs`)
- Obsidian plugin skeleton (`plugin/`)

## Project Layout

- `server/` Nitro API + migrations + sync logic
- `plugin/` Obsidian plugin MVP (register, push, pull, client-side encryption)
- `data/` runtime state (`app.db`, `blobs/`, `backups/`)
- `ops/` backup / restore-check / GC scripts

## Backend Setup

```bash
npm install
cp server/.env.example server/.env
npm --workspace server run db:migrate
npm run dev:server
```

API base URL: `http://127.0.0.1:3243`

### First device registration

```bash
curl -sS -X POST http://127.0.0.1:3243/api/v1/device/register \
  -H 'content-type: application/json' \
  -d '{"vaultName":"default","deviceName":"desktop"}'
```

Save returned `apiKey` in plugin settings.

## Plugin Setup

```bash
npm run build:plugin
```

Copy files from `plugin/dist/` into your Obsidian vault plugin folder:
- `plugin/dist/main.js`
- `plugin/dist/manifest.json`

## Implemented Endpoints

- `POST /api/v1/device/register`
- `POST /api/v1/device/revoke`
- `GET /api/v1/sync/state`
- `POST /api/v1/sync/push`
- `POST /api/v1/sync/pull`
- `PUT /api/v1/blob/:hash`
- `GET /api/v1/blob/:hash`
- `POST /api/v1/blobs/get`
- `POST /api/v1/blobs/missing`
- `GET /api/v1/file/versions?path=...`
- `POST /api/v1/file/restore`
- `POST /api/v1/admin/gc` (`x-admin-token` required)
- `GET /healthz`

## Notes

- Server stores only encrypted payloads. Encryption is performed in the plugin.
- Conflict strategy is `Hard LWW` (deterministic winner by server timestamp and device tie-breaker).
- This is a single-node v1 (no HA/failover).

## Troubleshooting

- `Sync failed: ... network error`: verify `Server URL`, that Nitro is running, and port `3243` is reachable.
- Too many requests during initial sync: plugin now batches blob download/upload (`/blobs/get`, `/blobs/missing`).
- Device suddenly unauthorized (`401`): API key was revoked; re-register device in plugin settings.
- Investigate performance: enable `Debug perf logs` in plugin settings and inspect developer console.
