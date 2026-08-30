# Quest Engineering Town client

```sh
# from the repository root
bun install
bun run dev

# or from this directory
bun test
bun run test:components
bun run typecheck
bun run check
bun run build
bun run screenshots:v014a # while the Vite client is running
bun run tauri dev
```

Browser development uses the Vite proxy, so it connects to the control plane at
`http://127.0.0.1:4000` without browser CORS configuration. Production or Tauri
builds use `VITE_QE_HTTP_BASE_URL` and `VITE_QE_SOCKET_URL`; these are the only
client networking configuration boundary.

The server's `QUEST_ENGINEERING_CLIENT_ORIGINS` is a narrow, comma-separated
origin allowlist for HTTP CORS and the `/client` WebSocket. The macOS WKWebView was integration-tested with the observed Origin
`tauri://localhost`; development configuration narrowly allows it. Before
shipping another platform, inspect that platform WebView's actual `Origin` and
add the exact value through the environment setting—never guess or use a
wildcard. The desktop shell has no filesystem, shell, Worker, or Herdr
permissions.

The first-run helper appears only when Classes, Loadouts, Squads, and Tactics
are all empty. It uses `/api/v1/execution-options` only as a convenience chooser
and creates ordinary Product rows through the existing API.

## Living-town development fixtures

Development builds expose a fixture chooser and query-addressable deterministic
scenes, for example:

```text
http://127.0.0.1:1420/?fixture=density&window=guild&scale=3&camera=town
```

Fixtures never call a Worker or model provider. `scripts/capture-v014a.ts` uses
local headless Chrome, freezes the Pixi canvas, captures the semantic DOM layer,
and alpha-composites both at exact CSS viewport/DPR dimensions. Set
`QE_CHROME_BIN` when Chrome is not installed at the macOS default path.

The world uses the original documented Mini Medieval PNG sheets directly with
cached framed Pixi textures. Source/license provenance and CC BY 4.0 attribution
are under `src/assets/mini-medieval/`. No generated runtime atlas is used.
