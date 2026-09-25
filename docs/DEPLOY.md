# Running in Claude Code cloud sessions and routines

`.mcp.json` starts the server with `scripts/mcp-cloud.sh`, which runs `npm ci` (first run only) and `npm run build`, then starts `node dist/index.js` over stdio. All npm and build output goes to stderr, because stdout carries the MCP protocol.

## Cloud environment settings

**Network access:** Custom, with the default package manager hosts plus:

- `api.sleeper.app`
- `api.sleeper.com`
- `site.api.espn.com`

**Environment variables:**

| Variable | Value | Why |
| --- | --- | --- |
| `SLEEPER_USERNAME` | your Sleeper username | Default user for "my team" questions. If unset, the server still starts with no default user. |
| `SLEEPER_MCP_READ_ONLY` | `1` | Keeps account write tools off. `.mcp.json` also sets it. |
| `NODE_USE_ENV_PROXY` | `1` | Sends Node's `fetch` through the environment's proxy (below). `.mcp.json` also sets it. |
| `MCP_TIMEOUT` | `120000` | Startup runs install and build first, which takes longer than the default MCP startup timeout. |

Do not set `SLEEPER_TOKEN`, `SLEEPER_EMAIL` or `SLEEPER_PASSWORD`.

## Why `NODE_USE_ENV_PROXY`

Verified in a cloud session: without it, ESPN returned 403 to the server's fetch calls while curl to the same URLs returned 200. With `NODE_USE_ENV_PROXY=1`, every smoke check passed. Setting a curl User-Agent without it also returned 200 in a one-off test. Not verified: whether ESPN reacts to the network path or to Node's default User-Agent. Node's docs say built-in fetch ignores `HTTPS_PROXY` unless this variable is set.

## Routines

Add no connectors to routines that use this server. It needs only the network hosts above.
