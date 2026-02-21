# MCP Debugging

## Why MCP worked in Terminal but failed in embedded PTY

The embedded session previously launched `claude` directly from PTY. That path did not reliably load the same login/interactive shell initialization that macOS Terminal uses (`~/.zprofile`, `~/.zshrc`, etc.).

MCP setup often depends on shell-initialized environment variables and PATH changes. If those files are not sourced, MCP connectors can fail to resolve binaries, sockets, or auth env.

## Fix implemented

Terminal startup now uses the user's login shell and runs Claude inside it:

- Detect shell from `$SHELL`
- Fallback to `/bin/zsh`
- Launch via `-lic` so login + interactive startup scripts are sourced
- Execute Claude through the shell command string

On macOS this is equivalent to:

```bash
/bin/zsh -lic "claude ..."
```

Full Access is appended in the same command string:

```bash
--dangerously-skip-permissions
```

The PTY process also explicitly inherits parent environment variables, and starts in the selected workspace directory.

## Diagnostics command

Use **Menu -> Copy terminal env diagnostics**.

This runs, through the same shell startup path:

- `env`
- `which claude`
- `claude --version`

Output is:

- copied to clipboard
- written to `artifacts/env-diagnostics.txt`

Use this file to compare app environment vs native Terminal when MCP differs.
