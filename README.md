# taskforge-cli

Command-line client for **Task Forge**. Sign in to any Task Forge server (`host:port`) and
create/assign tasks from the terminal, or let **Claude Code** do it from a plain-English prompt:

> "Assign Rahul a high-priority task in Website to fix the login redirect loop, due Friday, ~3h"

Zero dependencies. Works on Linux, macOS and Windows with **Node.js 18+**.

---

## 1. Install

```bash
npm install -g github:hexylon-dev/taskforge-cli
```

Check it worked: `taskforge --version`

Update to the latest version by running the same command again.
To uninstall: `npm uninstall -g taskforge-cli`

<details>
<summary>Other ways to install</summary>

From a local clone:

```bash
git clone https://github.com/hexylon-dev/taskforge-cli.git
npm install -g ./taskforge-cli
```

As an offline tarball: run `npm pack` in a clone, share `taskforge-cli-1.0.0.tgz`, then
`npm install -g taskforge-cli-1.0.0.tgz`.

Without npm's global install, you can also run the file directly: `node bin/taskforge.mjs <command>`.
</details>

## 2. Sign in

```bash
taskforge login
```

```
Task Forge URL (host:port): tasks.mycompany.com:4100
Email: you@company.com
Password: ********
✓ Logged in as You <you@company.com> — Your Company
```

- The URL is your Task Forge **API** address. `host:port`, `http://host:port`, `https://domain` and
  URLs ending in `/api` all work. The CLI checks `GET /api/health` before asking for your password.
- If your email belongs to several companies, you'll be asked to pick one (or pass `--company <slug>`).
- Your session is saved per user (`~/.config/taskforge/config.json`, `%APPDATA%\taskforge\config.json`
  on Windows) with owner-only permissions, and it refreshes itself automatically. Your password is never stored.
- Non-interactive: `TASKFORGE_PASSWORD=... taskforge login --url host:port --email you@x.com`

Each person signs in with their **own** Task Forge account. The server enforces the same rules as the
web app: you can only assign tasks to people you're allowed to assign to (your reporting subtree,
or anyone if your role has `tasks.create.any`).

## 3. Connect Claude Code

```bash
taskforge install-skill            # for all your projects (~/.claude/skills/taskforge)
taskforge install-skill --project . # or just for the current repo (.claude/skills/taskforge)
```

Start a new Claude Code session, then just ask:

- "Create a task for Priya in Mobile App: add dark mode to settings, due next Friday"
- "Give Amit, Neha and Raj each a task to review their module by tomorrow"
- "Make me an urgent task to renew the SSL cert"

Claude extracts the title, assignee, project, dates and so on, and runs `taskforge create`. If a name is
ambiguous (two Rahuls) or the project requires a custom field, Claude asks you before creating anything.

**Optional:** to skip the permission prompt each time, allow the CLI in Claude Code's settings
(`~/.claude/settings.json`):

```json
{ "permissions": { "allow": ["Bash(taskforge:*)"] } }
```

If your session expires, Claude will ask you to run `! taskforge login` in the prompt.

## 4. Use it yourself

```bash
taskforge whoami                       # who/where you're signed in
taskforge projects                     # projects you can see
taskforge users rahul                  # find people
taskforge fields --project "Mobile App"  # custom fields (required ones, select options)

taskforge create \
  --title "Fix login redirect loop" \
  --project Website \
  --assignee rahul.shah@company.com \
  --priority high \
  --due 2026-11-20 \
  --estimate 3h \
  --description "Users get bounced back to /login after SSO"
```

| Option | Values |
|---|---|
| `-a, --assignee` | name, email, id, or `me`. Repeat for several assignees; the first is primary |
| `-p, --project` | project name (partial is fine if unique) or id. Optional if you only have one project |
| `-d, --description` | free text |
| `--priority` | `urgent`, `high`, `normal`, `low` (`medium` = normal) |
| `--due`, `--start` | `YYYY-MM-DD`, `"YYYY-MM-DD HH:mm"`, ISO-8601, `today`, `tomorrow`, `+3d`, `+1w` |
| `--estimate` | `90`, `90m`, `2h`, `1h30m`, `1.5h` |
| `--field key=value` | custom field (repeatable). Select fields take the option label |
| `--parent <taskId>` | create as a subtask |
| `--github <url>` | link a PR/issue |
| `--json '<obj>'` | any of the above as JSON. `-` reads stdin, `@file.json` reads a file |
| `--dry-run` | resolve and validate everything, but don't create the task |

All commands except `login` print JSON. Exit codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error (server message is in `error`) |
| 2 | needs input: ambiguous/unknown name, missing project or required field (see `candidates`, `available`, `missing`) |
| 3 | not signed in or session expired: run `taskforge login` |

`taskforge logout` revokes the session on the server and removes the saved tokens.

## Development

```bash
cd taskforge-cli   # your clone
npm test        # end-to-end tests against a mock Task Forge API
```
