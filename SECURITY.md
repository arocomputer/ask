# Security

Report vulnerabilities through GitHub private vulnerability reporting:
https://github.com/arocomputer/ask/security/advisories/new

With `-w`, ask lets the chosen model edit files and run commands as you. That is what the flag
does, so it is not a vulnerability. Nor is `ask bench` running a task's `check`: it is your own
command, from your own bench file. A way for a read
run (`-r`) to write, or to run any command, is: through the official agents, a read run on Claude
Code or Opencode has only their file reading and search tools and no shell, and one on Codex runs
in Codex's read-only OS sandbox. So is a way for a task in a batch or bench file to get write
access past an explicit `-r`.
