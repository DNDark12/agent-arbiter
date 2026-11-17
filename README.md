# Agent Arbiter

Rules and accountability for Claude Code agents. Agent Arbiter asks before dangerous actions, records and sanctions rule breaks, scores agents, and teaches the next agent what earlier ones got wrong.

It works as soon as it is installed. No settings, keys or setup.

## Install

```
/plugin install agent-arbiter --marketplace DNDark12/agent-arbiter
```

In the desktop app: **+** next to the prompt box, then **Plugins**, **Add marketplace** with `DNDark12/agent-arbiter`, then **Add plugin**.

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
| `/arbiter release <id>\|all` | Release a violation |
| `/arbiter citizens` | Show agent scores |
| `/arbiter lessons` | Show lessons |
| `/arbiter judge` | Show reviews and pending findings |
| `/arbiter help` | List every command |

## Data and privacy

Data stays on your machine in `~/.claude/plugins/data/agent-arbiter/`. Prompts, code and tool output are not stored. Routine records are removed after 30 days.

The judge sends the brief, the final report and up to three written files to the model through your own session, with secrets masked. It runs at most 20 times a day per project and can be switched off with `/arbiter judge off`.

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
