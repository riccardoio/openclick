# App Memory

OpenClick keeps optional local app memories under:

```sh
~/.openclick/apps/<bundle-id>/memory.json
```

These are not replay scripts. They are structured affordances, avoid-rules, and observations such as "prefer the largest content window" or "this shortcut opened a new document".

Each memory fact has a status, source, confidence, evidence count, scope, and cause. Only `active` facts are added to planner prompts. New negative facts and execution critiques start as `candidate` memories, and one-off failures are not used as future guidance until repeated local evidence promotes them. Imported facts also start as candidates with reduced confidence, so shared memory can help discovery without silently overriding local behavior.

Share memories with another machine or project:

```sh
openclick memory export openclick-memory.json
openclick memory import openclick-memory.json
```

Negative memories are soft cautions, not hard blocks. They should steer the planner away from likely failure modes, but must not disable tools, shortcuts, windows, or future attempts.

