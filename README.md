# orca-redmine-proxy

This proxy lets [Orca](https://github.com/stablyai/orca) show and edit Redmine issues through its Jira integration. The proxy has the shape of a Jira Server REST API v2, and it answers each request with data from Redmine.

It is one file, `server.mjs`, and it needs only Node 22 with no dependencies. The proxy stores no secrets. Orca sends your Redmine API key with each request, and the proxy forwards the key to Redmine as `X-Redmine-API-Key`.

## Run

```bash
REDMINE_URL=https://redmine.example.com node server.mjs
```

| Variable | Default | Meaning |
|---|---|---|
| `REDMINE_URL` | (required) | Redmine base URL |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `KEY_PREFIX` | `RM` | Issue key prefix: Redmine `#123` is `RM-123` |

## Connect Orca

1. Open the Orca settings and add a Jira site of the Server / Data Center type.
2. Set the site URL to `http://127.0.0.1:8787`.
3. Leave the username empty.
4. Use your Redmine API key as the token.

To link an existing worktree to an issue, run `orca reference add RM-123 --worktree branch:<branch>`.

## Supported

- **Read:**
  - The connection check and the issue list. The issue list supports the JQL that Orca generates: assignee, reporter, status category, `status in`, `text ~`, `key =`, and `ORDER BY`.
  - The issue view, the comments, and the `/browse/RM-123` redirect.
  - The priorities, the projects, and the assignable users.
- **Write:**
  - A status change. The proxy builds the status menu from the Redmine workflow (`allowed_statuses`).
  - A title, priority, or assignee change.
  - A new comment and a new issue.
- **Not supported:**
  - Labels: Redmine has no labels, so the proxy returns 400.
  - Custom fields and the required fields for a status change: the proxy ignores them.
  - Any other JQL: the proxy returns 400, and Orca then falls back to text search.

## Start at login (macOS)

Save the following file as `~/Library/LaunchAgents/local.orca-redmine-proxy.plist`. Then change the Node path, the repo path, and `REDMINE_URL`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.orca-redmine-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/orca-redmine-proxy/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REDMINE_URL</key><string>https://redmine.example.com</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/orca-redmine-proxy.log</string>
  <key>StandardErrorPath</key><string>/tmp/orca-redmine-proxy.log</string>
</dict>
</plist>
```

Use these commands to control the LaunchAgent:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.orca-redmine-proxy.plist   # load and start
launchctl kickstart -k gui/$(id -u)/local.orca-redmine-proxy                            # restart after a code change
launchctl bootout gui/$(id -u)/local.orca-redmine-proxy                                 # stop and unload
```

## Test

```bash
node --test
```

The tests use a local stub of Redmine and do not need network access.
