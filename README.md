<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="plugins/agent-arbiter/icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="plugins/agent-arbiter/icon-light.png">
    <img src="plugins/agent-arbiter/icon.png" alt="Agent Arbiter icon: an A with a balance beam and jail bars" width="160" height="160">
  </picture>
</p>

# Agent Arbiter

Rules and accountability for Claude Code agents. Agent Arbiter asks before dangerous actions, records and sanctions rule breaks, scores agents, and teaches the next agent what earlier ones got wrong.

It works as soon as it is installed. No settings, keys or setup.

## Install

In a Claude Code session, run these commands **one at a time**. Add the marketplace first and wait for it to finish, then install the plugin:

```text
/plugin marketplace add DNDark12/agent-arbiter
/plugin install agent-arbiter@agent-arbiter
```

Choose an install scope when prompted. After installation, start a new session and run `/arbiter` to open its control panel.

From a terminal, use the equivalent commands:

```sh
claude plugin marketplace add DNDark12/agent-arbiter
claude plugin install agent-arbiter@agent-arbiter
```

In the desktop app: **+** next to the prompt box, then **Plugins**, **Add marketplace** with `DNDark12/agent-arbiter`, then **Add plugin**.

Requires Claude Code 2.1.325 or later, on macOS or Linux.

## Features

- **Gate.** Asks before force pushes, hard resets, recursive removals, database resets, dependency changes and writes outside the project, including commands wrapped in Docker, Sail, `bash -c` or `ssh`.
- **Rules.** Switch built-in rules on or off and add your own by path or command pattern. A rule can ask, deny, or deny and detain.
- **Discipline.** A warning for the main agent; a fine, then detention, for a subagent. A detained agent type restarts on another model.
- **Scores and lessons.** Compare main agent turns and subagent runs by model, time, token usage and rule history in the project or across projects. Quality is grouped by role and difficulty with the number of scored reviews. New subagents can receive lessons from earlier violations.
- **Judge.** Advisory reviews of main agent turns and subagent runs with recorded work evidence. A finding counts only when you confirm it.
- **Band and notes.** The [progress band](#progress-band) above the prompt shows items waiting for you and work in progress. **Open** takes you to the relevant panel, and a toast says when something new arrives. Under each tool call Arbiter stopped to check, a short note names the rule and its outcome. The desktop app's right-click menu opens the panel too.
- **Role icons.** Each agent role has a pixel icon that idles with a small bob and blink, held still when your system asks for reduced motion; a detained agent stands behind bars. Scores, quality and clean runs are drawn as bars against their known totals.
- **Session activity.** Open the agent strip to see a subagent's current tool and elapsed time. Inbox shows open questions and approval dialogs the plugin observes. Agents → Session History shows reported token usage, prompt wait time, context for the current session, and failed or unconfirmed checks. A successful retry of the same check closes a recorded failure.
- **Checklist.** The plugin observes native task calls where available. The main agent can also declare and update tasks through the session progress tool. Session History keeps the list so work can resume later.

## Usage

Open **`/arbiter`** to see the Inbox.

| Tab | What you can do |
|---|---|
| **Inbox** | Review findings and suggested exemplars, or open a detained agent’s docket |
| **Settings** | Global enable/language, project mode, judge, lessons, comparison group, ledger status and maintenance |
| **Rules** | Switch system rules on/off; create, edit and delete custom rules; search and filter |
| **Violations** | Filter and inspect violations; release one or all with a reason and confirmation |
| **Agents** | Project/all-project scores, project role overrides, lessons/shared library, and judge decisions |

Use **This thread** or **This project** to filter activity. On Claude Desktop, **Pin project** opens Arbiter when a thread in that project connects. Closing the pane dismisses it for the current session.

Global enable and language apply across projects on this computer. Mode, rules, judge, lessons and roles are saved per project. The pane shows when a global disable makes a project's rules inactive.

Maintenance actions explain their scope and ask for confirmation. Deleting data also opens an approval dialog. Resetting rules keeps judge, lesson and role preferences, along with violation history.

Existing commands still work as optional shortcuts. `/arbiter rules` opens Rules directly; `/arbiter off` is the emergency switch. Use `/arbiter help commands` for the command list and `/arbiter help advanced` for the experimental hardened runtime.

### Progress band

The band above the prompt helps you see whether Claude needs a decision from you or work is still running. In the compact view, an open review takes priority over a running subagent. Once you decide the review, the subagent takes over. If it finishes while the checklist still has open tasks, the checklist takes over. Recent completions can appear when there is no active work.

Select **≡** when several rows are available to see the expanded list, including judge usage. On Claude Desktop, Arbiter's progress bars start and end at the same columns. Narrow the window far enough and the band switches to counts beside the labels. When a bar reaches 100%, the fill reaches both right corners. An active progress mod can display its own band alongside Arbiter's with a separate layout.

To show a checklist, open `/arbiter` and enable **Session checklist** under **Settings → Session display** for the current project. If you also enable **Hide finished checklist after 30 seconds**, complete the list and check that its row disappears after about 30 seconds. Open **Agents → Session History** after resuming the session to find the completed list.

## Built-in rules

Every project starts with one standard set that fits any language. Each rule asks before the action runs unless noted. Switch any of them off, or add project-specific rules (a path, a command pattern, a stricter effect) in **Rules**.

| Rule | Covers, for example |
|---|---|
| Force push | `git push --force`, `+ref` pushes |
| Hard reset | `git reset --hard` |
| Discard uncommitted work or delete branches | `git checkout -- .`, `git restore`, `git clean -f`, `git branch -D`, `git stash drop` |
| Remove files or directories | `rm -rf`, `find -delete` (temporary and rebuildable folders excepted) |
| Reset database | `migrate:fresh`, `db:reset`, `prisma migrate reset`, `flyway clean`, `alembic downgrade base`, `mix ecto.reset`, `dotnet ef database drop`, `docker compose down -v` |
| Drop or empty databases, tables or schemas | `DROP` and `TRUNCATE` in SQL, `dropdb`, `sequelize db:drop` |
| Change dependencies | npm, yarn, pnpm, bun, composer, pip, uv, poetry, pipenv, cargo, go, bundle, dotnet, deno, conda |
| Publish a package or deploy | `npm publish`, `cargo publish`, `twine upload`, `docker push`, `gh release create`, `terraform apply`, `kubectl apply`, `helm upgrade`, `vercel --prod`, `fly deploy`, `wrangler deploy` |
| Run code downloaded from the internet | `curl … \| sh`, `wget -O- … \| bash`, `curl … \| python3` |
| Run commands as administrator | `sudo`, `doas` |
| Write outside the project | writes outside the project and its git worktrees, except temporary folders and `/dev/null` |
| Change Claude settings or agent definitions | `.claude/settings*.json`, agent definitions |
| Change Agent Arbiter data or code | always denied |
| Commit, Push, Run database migrations or seeders | off until you switch them on |

## Update

Run `/arbiter update` in a session: it refreshes the marketplace, then updates the plugin. From a terminal, the same two steps are:

```sh
claude plugin marketplace update agent-arbiter
claude plugin update agent-arbiter@agent-arbiter
```

Start a new Claude Code session after updating. Existing project preferences and Arbiter data are kept.

Settings shows the loaded version and an Update button. Enable the update check to compare an official marketplace installation with the public manifest on GitHub. The check respects Claude Code's nonessential-traffic setting.

## Data and privacy

Data stays on your machine in `~/.claude/plugins/data/agent-arbiter/`. Prompts, code and tool output are not stored. Routine records are removed after 30 days.

Session progress records use timings, verification categories and fingerprints, and short redacted checklist labels. History reports when older measurements are incomplete.

The judge sends the brief, the final report and up to three written files to the model through your own session, with secrets masked. For a main-agent turn the brief is the prompt you typed for that turn. It runs at most 20 times a day per project, of which main-agent turns may use at most 10, and can be switched off with `/arbiter judge off`.

Uninstalling the plugin keeps this data. Run `/arbiter purge all` first to remove it.

## Limits

Agent Arbiter catches agent mistakes. It is not a security boundary against an agent that sets out to bypass it.

## Development

```sh
claude --plugin-dir "$(pwd)/plugins/agent-arbiter"
node --test tests/*.test.mjs
claude plugin test plugins/agent-arbiter
```

| To change or check | Where to look |
|---|---|
| Which row the band shows and how the expanded rows line up | [Band renderer](plugins/agent-arbiter/hooks/band.js) |
| How the filled area and the completed edge are drawn | [SVG renderer](plugins/agent-arbiter/hooks/visuals.js) |
| Whether priority, narrow layouts and the finished edge still work | [Band regression tests](tests/band.test.mjs). Run `node --test tests/band.test.mjs`. |

## License

MIT
