# Zooza Claude plugin

Claude Code / Cowork plugin exposing Zooza tools and workflows. Bundles MCP server
wiring (`.mcp.json`), skills, and slash commands.

The MCP server itself lives in the repo root (`../src`) and is deployed separately
to Azure (see `../.github/workflows/docker-image-*.yml`). This plugin is just the
client-side bundle that points at it.

## Layout

```
plugin/
├── .claude-plugin/plugin.json   # manifest
├── .mcp.json                    # MCP wiring — currently points at local dev server
├── .mcp.json.example            # template with test/prod URLs
├── skills/                      # auto-discovered Cowork skills
└── commands/                    # auto-discovered slash commands
```

## Local testing

1. Start the MCP server in another terminal (from repo root):

   ```bash
   npm run dev                      # tsx watch
   # or
   npm run build && npm start       # node dist/index.js
   ```

   Server listens on `http://localhost:3001/mcp` — which is what `.mcp.json`
   currently points at.

2. Load the plugin in Claude Code:

   ```bash
   claude --plugin-dir ./plugin
   ```

3. Or upload to Cowork: **Customize → Browse plugins → upload** the zip produced
   by the release workflow (see below).

## Distribution

The plugin is packaged by **`.github/workflows/plugin-release.yml`**. Push a tag
matching `plugin-v*` (e.g. `plugin-v0.1.0`) and the workflow will:

1. Copy `.mcp.json.example` over `.mcp.json` (so the shipped bundle points at the
   deployed URL, not localhost).
2. Zip the `plugin/` directory.
3. Attach the zip to a GitHub Release for that tag.

Users then download the zip and upload it in Cowork, or install it in Claude Code.

### Before tagging a release

- Update `version` in `.claude-plugin/plugin.json`.
- Confirm `.mcp.json.example` points at the right environment (default: prod).
- If you want a test build, change the URL in `.mcp.json.example` to the test
  hostname before tagging, or extend the workflow to publish per-environment
  artifacts.

## Auth

The MCP server uses per-user OAuth (see repo root `README.md` and `src/auth/`).
The plugin itself carries no credentials — when a user connects, the server
challenges them through the normal OAuth flow.
