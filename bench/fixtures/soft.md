---
name: ask
description: Hands work to subagents that run in the background, on any model - questions that need a lot of reading, reviews, fixes, or several tasks at once.
---

ask runs subagents in the background, each in a fresh context of its own. Send one JSON request
on stdin, read one JSON response on stdout. `ask help requests` is the full reference; `ask
models` lists the models.

## When to hand work off

- A question that needs a lot of searching and reading: the subagent spends its context, you
  get the answer with path:line evidence.
- Independent pieces of work: start them all in one request and they run at once.
- A review or a second opinion, possibly on another model.
- Not a single file read or a one-line edit: doing those yourself is faster.

## Writing the task

The subagent sees only its prompt: not this conversation, not your notes. Write it like a
handoff to a capable colleague who just arrived:

- The goal, and why it matters.
- What you already know: the files, functions and findings involved, errors verbatim.
- The boundaries: what not to touch, what is out of scope.
- What done means: the tests that must pass, the question that must be answered.
- What to return: "each call site with path:line", "the diff and the test output".

For several tasks at once, give each its own slice, so they don't overlap or leave gaps.

## Choosing

- Read-only (the default) for questions and reviews. `"write": true` lets it change files in
  your folder; `"worktree": true` gives it its own branch and checkout instead, which suits
  bigger changes and several write tasks at once.
- `"model"` and `"effort"`: the default for most tasks; a stronger model, or `"effort":
  "high"`, for hard bugs and design questions.
- `"schema"` when you'll process the answer: it comes back as JSON matching it.

## Requests

    ask <<'EOF'
    {"start": [{"prompt": "..."}, {"prompt": "...", "write": true}], "wait": 600}
    EOF

A task is {"prompt", "model"?, "write"?, "worktree"?, "dir"?, "effort"?, "schema"?, "timeout"?}.
Every response is {"tasks": [{"id", "state", "answer"?, "error"?, "changes"?, ...}]}; state is
running, retrying, succeeded, failed or stopped. Then:

    {"collect": ["ID", ...], "wait": 600}     wait for more of them to finish
    {"continue": "ID", "prompt": "..."}       a follow-up in the same conversation; any model
    {"continue": "ID"}                        resume a stopped or failed task
    {"stop": ["ID"]}
    {"show": "ID"}                            every step it took
    {"sessions": {}}                          the sessions this conversation started

Wait as long as your shell allows, and collect again while tasks are running. Follow a
response's "hint". An {"error": {"message", "hint"}} means the request itself was wrong.

## Using the results

- Check the claims you'll build on: open the path:line it cites. For a write task, look at
  "changes" and the diff before you rely on it.
- To correct or extend a task, continue it rather than starting over: it keeps everything it
  read and did.
