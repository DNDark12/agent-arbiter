<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="icon-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="icon-light.png">
    <img src="icon.png" alt="Agent Arbiter icon: an A with a balance beam and jail bars" width="160" height="160">
  </picture>
</p>

# Agent Arbiter

A Claude Code mod that sets rules for agents and holds them to those rules. It works on install: no settings, keys or setup.

In a Claude Code session, add the marketplace first. Wait for it to finish, then install the plugin:

```text
/plugin marketplace add DNDark12/agent-arbiter
/plugin install agent-arbiter@agent-arbiter
```

Run each command separately and choose an install scope when prompted. Start a new session after installation, then run `/arbiter status` to check that the plugin loaded.

From a terminal:

```sh
claude plugin marketplace add DNDark12/agent-arbiter
claude plugin install agent-arbiter@agent-arbiter
```

- Asks before destructive or irreversible actions, including commands wrapped in Docker, Sail, `bash -c`, `ssh`, `xargs` or `find -exec`.
- `/arbiter rules` opens a pane to switch built-in rules and manage your own, with ask, deny, or deny and detain.
- Records violations: a warning for the main agent; a fine, then detention, for a subagent. A detained agent type restarts on another model.
- Scores each agent type and model, and tells a new agent what earlier ones of its type or role were stopped for.
- Reviews each finished subagent run with one small model call. The judge is advisory: a finding counts only when you confirm it.

Prompts, code and tool output are not stored. This mod catches agent mistakes; it is not a security boundary.

Source: https://github.com/DNDark12/agent-arbiter
