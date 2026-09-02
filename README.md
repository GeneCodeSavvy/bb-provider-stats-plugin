# Provider Stats

A BB plugin for two related jobs: switching local AI-provider logins and seeing subscription/API usage headroom in one place.

## Providers

| Provider | Account switching | Usage |
| --- | --- | --- |
| Codex | `~/.codex/auth.json` + saved local slots | BB native `system.usageLimits()` |
| Claude Code | `~/.claude/.credentials.json` + saved local slots | BB native `system.usageLimits()` |
| Grok Build | `~/.grok/auth.json` (or `GROK_HOME`) + saved local slots | Grok subscription + task-usage endpoints |
| OpenCode Go | API-key providers are usage-only | `OPENCODE_API_KEY` against Zen Go usage |
| OpenRouter | API-key providers are usage-only | `OPENROUTER_API_KEY` against credits |

For Codex, the live credential location is intentionally fixed to `~/.codex/auth.json`. The plugin does not use `CODEX_HOME`, `~/.codex-personal`, `~/.codex-work`, or any alternate Codex profile directory. Saved account slots are private snapshots in the plugin host data directory; activating a slot atomically replaces only `~/.codex/auth.json`.

Account credentials are copied only by the BB host entry, into the plugin host data directory. The server stores labels and timestamps, not credential contents. Switching uses an atomic temporary-file rename and affects new provider sessions only.

Claude Code may keep credentials in macOS Keychain. BB can still report Claude usage in that case, but this plugin deliberately does not read/write the Keychain; account switching is enabled only when Claude Code's credential file exists.

## Design notes

The account model follows the safety lessons used by Tokscale: credential sources remain provider-owned, quota viewing is read-only, saved accounts are explicit local snapshots, and active state is derived from the actual current credential rather than trusting persisted UI metadata. Provider-specific behavior is isolated behind the host contract so additional providers can be added without reworking the UI.

Usage values are provider-reported. Codex and Claude use BB's native quota API. Grok, OpenCode Go, and OpenRouter are fetched from their vendor endpoints and normalized to `{ label, usedPercent, resetsAt }` windows.

## Development

```bash
npm install
bb plugin build
bb plugin install .
```

After changes:

```bash
bb plugin reload codex-capacity
```
