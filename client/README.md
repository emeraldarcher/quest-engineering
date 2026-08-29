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
