---
name: self-improvement
description: "Injects self-improvement reminder during agent bootstrap"
metadata: {"openclaw":{"emoji":"🧠","events":["agent:bootstrap"]}}
---

# Self-Improvement Hook

Injects a reminder to evaluate learnings during agent bootstrap.

## What It Does

- Fires on `agent:bootstrap` (before workspace files are injected)
- Adds a reminder block to check `.learnings/` for relevant entries
- Prompts the agent to log corrections, errors, and discoveries

## Configuration

No configuration needed. Enable with:

```bash
openclaw hooks enable self-improvement
```

## memory-lancedb-pro

If you use the **memory-lancedb-pro** plugin with self-improvement enabled, the reminder is already injected from LanceDB at prompt time. Skip enabling this hook to avoid two reminders (virtual file + merged injection). See `INTEGRATION.md` next to this skill in the plugin bundle.
