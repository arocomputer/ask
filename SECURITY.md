# Security

Report vulnerabilities through GitHub private vulnerability reporting:
https://github.com/arocomputer/ask/security/advisories/new

With `-w`, ask lets the model edit files and run commands as you. That is what the flag does, so
it is not a vulnerability. A way for a read session to write a file or run a command is: a native
read session is given no tool that can do either, and tool paths are confined to the session's
directory. Through the external harnesses, a read session on Claude Code has only its file reading and search
tools and no shell, and one on Codex runs in Codex's read-only sandbox.

Credentials live in `~/.ask/auth.json` with mode 0600 and never enter a session's tool environment
or its records. Run records and activity are private to your user but unredacted: they hold
prompts, answers, commands and file contents.
