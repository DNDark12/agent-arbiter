# Agent Arbiter

A Claude Code mod that sets rules for agents and holds them to those rules. It works on install: no settings, keys or setup.

- Asks before destructive or irreversible actions, including commands wrapped in Docker, Sail, `bash -c`, `ssh`, `xargs` or `find -exec`.
- `/arbiter rules` opens a pane to switch built-in rules and manage your own, with ask, deny, or deny and detain.
- Records violations: a warning for the main agent; a fine, then detention, for a subagent. A detained agent type restarts on another model.
- Scores each agent type and model, and tells a new agent what earlier ones of its type or role were stopped for.
- Reviews each finished subagent run with one small model call. The judge is advisory: a finding counts only when you confirm it.

Prompts, code and tool output are not stored. This mod catches agent mistakes; it is not a security boundary.

Source: https://github.com/DNDark12/agent-arbiter
