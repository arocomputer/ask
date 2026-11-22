# Caller delegation pilot — November 2026

Two repeats of three jobs that explicitly requested delegation. Each combination also ran
the non-delegation control. None of the prompts named ask.

| Caller | Native/control | Current skill | Soft skill | Current skill, native denied |
| --- | --- | --- | --- | --- |
| Claude Code | Native 6/6 | Ask 6/6 | Native 6/6 | Ask 6/6 |
| Codex `exec` | Self 6/6 | Ask 6/6 | Ask 6/6 | Ask 6/6 |
| OpenCode Go | Native 6/6 | Ask 4/6 | Not rerun on Go | Ask 6/6 |

Claude Code and Codex passed all four fixtures in these runs, including the non-delegation
job. The OpenCode Go caller was `opencode-go/deepseek-v4.1-flash`; ask's default worker was
`opencode-go/glm-5.3`. The original metered OpenCode run hit quota and used a different
caller model, so do not pool it with the Go rerun. Shared-provider rate limiting caused
retries and extra calls in several arms; these runs do not rank latency or cost.

Keep the skill as the portable default. The stronger description changed Claude Code's
routing. For users who want ask to handle every delegation, the skill with native subagents
disabled was the most consistent option in this pilot. A native-call hook worked in Claude
Code and OpenCode, but depended on caller-specific behavior and had nothing to intercept
in Codex. We removed the prototype.
