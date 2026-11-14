---
name: taskforge
description: Create and assign tasks in Task Forge via the `taskforge` CLI. Use whenever the user asks to create, assign, delegate, or log a task/todo/ticket for someone (or themselves) in Task Forge — e.g. "assign Rahul a task to fix the login bug by Friday", "create a high-priority task in Website for me", "give the QA team a task to test checkout". Also use to look up Task Forge users, projects, or a project's custom fields.
---

# Task Forge task creation

The `taskforge` CLI talks to the user's Task Forge server. Every command except `login`
prints one JSON object to stdout: `{"ok": true, ...}` or `{"ok": false, "error": "...", ...}`.

## Exit codes — act on them

| Code | Meaning | What to do |
|---|---|---|
| 0 | Success | Report the result |
| 2 | Needs input — ambiguous/unknown name, missing project or required field | Read `candidates` / `available` / `missing` from the JSON, ask the user to choose (don't guess between people), then retry |
| 3 | Not logged in / session expired | Tell the user to run `! taskforge login` (it prompts for URL, email and a hidden password; you cannot do it for them) |
| 1 | Other error (permission, server down, validation) | Show the `error` message |

## Workflow

1. **Extract** from the user's request: title (short, imperative), description (any extra
   context, acceptance criteria, links), assignee(s), project, priority, due/start date, estimate.
2. **Resolve the project** if not obvious: `taskforge projects` (optionally `taskforge projects <query>`).
   If the user named no project and there are several, ask — or pick one only if the request
   makes it unambiguous.
3. **Create** with a single command. Names are resolved by the CLI (exact email/name, then
   first-name/prefix, then substring), so pass what the user said:

   ```bash
   taskforge create \
     --title "Fix login redirect loop" \
     --project "Website" \
     --assignee "rahul" \
     --priority high \
     --due 2026-11-20 \
     --estimate 3h \
     --description "Users get bounced back to /login after SSO. Repro: ..."
   ```

   For long or multi-line descriptions, prefer JSON on stdin to avoid quoting issues:

   ```bash
   taskforge create --json - <<'EOF'
   {
     "title": "Fix login redirect loop",
     "project": "Website",
     "assignees": ["rahul", "priya@acme.com"],
     "priority": "high",
     "due": "2026-11-20",
     "estimate": "3h",
     "description": "Users get bounced back to /login after SSO.\n\nAcceptance:\n- ..."
   }
   EOF
   ```

4. **Handle exit code 2** — e.g. `"reason": "ambiguous"` with two Rahuls: ask the user which one
   (show name + email + job title), then retry using the chosen **email or id**.
   `"reason": "missing_required_fields"`: ask for those values (options are listed), then retry
   with `--field "<key>=<value>"`.
5. **Confirm** to the user in one line: task title, assignee(s), project, due date, task id.

## Options reference

- `--assignee` / `-a` — repeatable; name, email, id, or `me`. First one is the primary assignee.
  Omit to create an unassigned task.
- `--priority` — `urgent | high | normal | low` (aliases: medium→normal, critical→urgent).
- `--due`, `--start` — `YYYY-MM-DD`, `"YYYY-MM-DD HH:mm"` (local), ISO-8601, `today`, `tomorrow`,
  `+3d`, `+1w`. Convert relative phrases like "next Friday" to an absolute `YYYY-MM-DD` yourself
  (check today's date first).
- `--estimate` — minutes or `2h`, `1h30m`, `1.5h`. Some companies require an estimate; if the
  server says "An estimate is required", ask the user or make a reasonable estimate and say so.
- `--field key=value` — custom fields (repeatable). Select/multiselect take option labels
  (multiselect: comma-separated). See `taskforge fields --project <p>`.
- `--parent <taskId>` — create as a subtask.
- `--dry-run` — resolves everything and prints what would be created, without creating it.
  Use it when the request is large or you're unsure of the interpretation.

## Several tasks at once

Run one `taskforge create` per task (e.g. "give each of Amit, Neha and Raj a task to review
their module" → three commands, one assignee each). If the user wants one shared task, pass
multiple `--assignee` flags to a single command.

## Lookups

- `taskforge whoami` — who is signed in and to which server/company.
- `taskforge users [query]` — active users (id, name, email, jobTitle, role).
- `taskforge projects [query]` — visible projects.
- `taskforge fields --project <p>` — custom fields, which are required, and select options.

## Permissions

The server only lets the signed-in user assign tasks to people in their reporting subtree
(unless they have `tasks.create.any`). A "not allowed to create a task for this assignee"
error is a permission rule, not a bug — tell the user.
