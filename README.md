<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="extension/icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="extension/icon-light.png">
    <img src="extension/icon.png" alt="Agent Arbiter icon: an A with a balance beam and jail bars" width="160" height="160">
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

Choose an install scope when prompted. After installation, start a new session and run `/arbiter status` to check that the plugin loaded.

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
- **Scores and lessons.** Trust and quality per agent type and model. New agents are told what earlier ones were stopped for.
- **Judge.** An advisory review of each finished subagent run. A finding counts only when you confirm it.

## Usage

| Command | Purpose |
|---|---|
| `/arbiter rules` | Open the pane: rules, violations, agents, settings |
| `/arbiter mode enforce\|observe\|off` | Set the mode for the project |
| `/arbiter docket` | List violations |
| `/arbiter release <id> [reason]` | Release a violation |
| `/arbiter citizens [all]` | Show agent scores for this project or all projects |
| `/arbiter lessons` | Show lessons and how well they work |
| `/arbiter judge` | Show reviews and pending findings |
| `/arbiter purge [all]` | Delete Arbiter's data |
| `/arbiter help` | List every command |

## Data and privacy

Data stays on your machine in `~/.claude/plugins/data/agent-arbiter/`. Prompts, code and tool output are not stored. Routine records are removed after 30 days.

The judge sends the brief, the final report and up to three written files to the model through your own session, with secrets masked. It runs at most 20 times a day per project and can be switched off with `/arbiter judge off`.

Uninstalling the plugin keeps this data. Run `/arbiter purge all` first to remove it.

## Limits

Agent Arbiter catches agent mistakes. It is not a security boundary against an agent that sets out to bypass it.

## Development

```sh
claude --plugin-dir "$(pwd)/extension"
node --test tests/*.test.mjs
claude plugin test extension
```

## License

MIT
