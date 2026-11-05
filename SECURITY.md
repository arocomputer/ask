# Security

Report vulnerabilities through GitHub private vulnerability reporting:
https://github.com/arocomputer/ask/security/advisories/new

A write task (`"write": true`) lets the model edit files and run commands as you. That is what it
asks for, so it is not a vulnerability. A way for a read-only task to write a file or run a
command is: a read-only task is given no tool that can do either, and tool paths are confined to
the task's folder, symlinks included.

Pasted keys and the ChatGPT sign-in's tokens live in `~/.ask/auth.json` with mode 0600 and never
enter a task's tool environment or its records; neither do `*_API_KEY` variables. The ChatGPT
sign-in checks the ID token's signature against OpenAI's published keys, and its issuer,
audience, expiry and nonce, before saving anything. Session records are private to your user but
unredacted: they hold prompts, answers, commands and file contents.
