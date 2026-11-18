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

Run each command separately and choose an install scope when prompted. Start a new session after installation, then run `/arbiter` to open its control panel.

From a terminal:

```sh
claude plugin marketplace add DNDark12/agent-arbiter
claude plugin install agent-arbiter@agent-arbiter
```

- Asks before destructive or irreversible actions, including commands wrapped in Docker, Sail, `bash -c`, `ssh`, `xargs` or `find -exec`.
- `/arbiter` opens one control panel: Settings, Rules, Violations and Agents. Change enable/language, mode, judge and lessons; manage rules, release violations, set agent roles, share lessons and decide review findings without typing commands or IDs.
- System rules only switch on/off; custom rules have full create/read/update/delete, with ask, deny, or deny and detain.
- Maintenance and deletion show their scope and require confirmation; ordinary changes persist immediately.
- Records violations: a warning for the main agent; a fine, then detention, for a subagent. A detained agent type restarts on another model.
- Scores each agent type and model, and tells a new agent what earlier ones of its type or role were stopped for.
- Reviews each finished subagent run with one small model call. The judge is advisory: a finding counts only when you confirm it.

Prompts, code and tool output are not stored. This mod catches agent mistakes; it is not a security boundary.

Update from a terminal:

```sh
claude plugin marketplace update agent-arbiter
claude plugin update agent-arbiter@agent-arbiter
```

Start a new session after updating. Existing data and project preferences are retained. `/arbiter rules` and the older commands remain optional shortcuts; `/arbiter off` is the emergency switch. See `/arbiter help advanced` for experimental hardened-runtime commands.

Source: https://github.com/DNDark12/agent-arbiter
