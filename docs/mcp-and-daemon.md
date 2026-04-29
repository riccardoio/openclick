# MCP And API Daemon

## MCP Server

For MCP clients that launch a stdio server:

```sh
openclick mcp
```

MCP tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `run_task` | `{ "task": string, "live"?: boolean, "allowForeground"?: boolean, "criteria"?: string }` | Runs a natural-language macOS desktop task through OpenClick and returns CLI text output. `live` defaults to `true`. |
| `status` | none | Runs `openclick doctor --json` and returns the JSON status text. |

## API Daemon

Install the local API server as a user launchd daemon so it starts at login and stays running:

```sh
openclick daemon install --host 127.0.0.1 --port 4242
openclick daemon status
openclick daemon uninstall
```

With token auth:

```sh
openclick daemon install --host 127.0.0.1 --port 4242 --token <token>
```

The daemon label is `dev.openclick.server`. Logs are written under:

```sh
~/.openclick/server.log
~/.openclick/server.err.log
```

