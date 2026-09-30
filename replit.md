# Signalboard

An editable, browser-based dashboard builder for arranging low-level telemetry widgets fed by a live Node.js WebSocket stream.

## Run & Operate

- `pnpm --filter @workspace/widget-dashboard run dev` — run the dashboard editor
- `pnpm --filter @workspace/api-server run dev` — run the REST and WebSocket API
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- No database or secret is required for the current dashboard prototype.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/widget-dashboard/` — React dashboard editor and widget renderers
- `artifacts/api-server/src/lib/telemetry.ts` — telemetry source catalog and sample value generator
- `artifacts/api-server/src/index.ts` — HTTP server and WebSocket stream at `/api/ws`
- `artifacts/api-server/src/routes/telemetry.ts` — initial snapshot endpoint
- `lib/api-spec/openapi.yaml` — source of truth for REST contracts

## Architecture decisions

- Dashboard layouts are saved to the current browser's local storage; accounts and cross-device sync are not part of this prototype.
- The backend emits simulated telemetry once per second so the editor has a working end-to-end WebSocket path before a production data source is selected.
- The REST snapshot is described in OpenAPI and generated client types; WebSocket updates use an `updates` array of source readings.

## Product

Users can arrange value, trend, gauge, status, and event widgets, reorder and resize them in edit mode, choose telemetry sources, and switch to a read-only view.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The API artifact must route `/api/ws` as well as `/api` so the preview proxy forwards WebSocket upgrades.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
