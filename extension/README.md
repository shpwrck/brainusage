# brainusage@altairinglorious GNOME Extension

Minimal GNOME Shell extension scaffold for GNOME 45+ (tested target: GNOME 46).

## What this includes

- Top-bar indicator showing one or more remaining-usage metrics
- Clean enable/disable lifecycle
- Provider wiring for Claude and Codex usage data
- Scheduler polling on a configurable interval (default 3 minutes)
- Notifications at a configurable remaining threshold (default 20%) for both session and weekly limits
- Preferences window (`prefs.js`) plus quick toggles in the indicator popup

## Configuration

Open the preferences from the indicator popup ("Settings") or via the GNOME
Extensions app. Everything is stored in GSettings
(`org.gnome.shell.extensions.brainusage`):

- `panel-items` (string array) — which metrics appear in the top bar, in order.
  Any of `min`, `claude-session`, `claude-weekly`, `codex-session`,
  `codex-weekly`. Default `['min']`.
- `panel-show-labels` (bool) — prefix each value with its window label
  (`Session`, `Week`, `Min`). Provider metrics always carry the provider logo,
  and every value is colored by health status (green / yellow / red), e.g.
  `[Claude logo] Session 60% · [OpenAI logo] Session 73%`. Default `true`.
- `poll-interval-seconds` (int, 60–3600) — seconds between usage polls.
  Default `180`.
- `notifications-enabled` (bool) — toggle low-usage notifications. Default `true`.
- `notify-threshold-pct` (int, 1–99) — remaining percentage that triggers a
  notification. Default `20`.
- `panel-label-mode` (string, deprecated) — pre-1.1 single-metric setting;
  migrated into `panel-items` on first enable.

## Local checks

From repository root:

```bash
bun install
bun test
gnome-extensions pack extension --force
```

Smoke pack script output is written to `.sisyphus/evidence/task-0-pack.txt`.

## Ubuntu GNOME local packaging workflow

Run all commands from repository root.

### Pack extension zip

```bash
bash scripts/dev/pack.sh
```

Expected artifact: `brainusage@altairinglorious.shell-extension.zip` in repo root.

### Install locally (user scope)

```bash
bash scripts/dev/install.sh
```

This installs/updates `brainusage@altairinglorious` in your local GNOME extensions directory.

### Enable extension

```bash
bash scripts/dev/enable.sh
```

### Disable extension

```bash
bash scripts/dev/disable.sh
```

### Troubleshooting GNOME Shell logs

```bash
journalctl --user -f /usr/bin/gnome-shell
```

Useful focused variant:

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -E 'brainusage@altairinglorious|extension|JS ERROR'
```
