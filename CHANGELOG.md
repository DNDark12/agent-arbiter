# Changelog

## 1.0.0

First public release.

- Gate that asks before destructive or irreversible actions, including commands wrapped in Docker, Sail, `bash -c`, `ssh`, `xargs` and `find -exec`.
- Built-in rules that switch on or off, and custom rules by path or command pattern with ask, deny, or deny and detain.
- Discipline: a warning for the main agent; a fine, then detention, for a subagent. A detained agent type restarts on another model for seven days or until released.
- Release with a reason, from the pane or `/arbiter release`.
- Agent scores per type and model, in one project or across all of them.
- Lessons from violations and confirmed findings, taught to the next agent of the same type or role, shareable across projects, with an optional control group.
- Advisory judge: one small model call per finished subagent run, at most 20 a day per project. Difficulty is fixed from the brief before the run. Reviewers, testers and security agents can file complaints against the agent that wrote the code.
- Status line entry for detained agents and findings waiting for a decision.
- English and Vietnamese interface.
- Routine records removed after 30 days; `/arbiter purge` deletes Arbiter's data.
- macOS and Linux. Inactive on Windows.
- Directory listing metadata: display name, icon, homepage, support link, engine range.
