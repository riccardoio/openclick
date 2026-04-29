# Development

Run checks:

```sh
bun run format
bun run lint
bun run typecheck
bun test
swift build --package-path mac-app -c release
swift test --package-path mac-app
```

Useful live smoke tests:

```sh
bun ./bin/openclick run "open Calculator and calculate 22 times 27; stop when the display shows 594" --live
bun ./bin/openclick run "open Safari and search Google for OpenAI; stop when Google search results are visible" --live
```

## Contributor Notes

- Prefer generic capabilities over app-specific prompt hacks.
- Keep model budgets visible and bounded.
- Preserve shared-seat behavior by default: classify new primitives as background-safe or foreground-required before exposing them to the planner.
- Treat screenshots as primary evidence for visual apps and browser content.
- Treat AX trees as useful but often incomplete.
- Do not accept weak visual success criteria just because an app or canvas is visible.
- Give high-risk visual actions a concrete expected visible change and critique/replan when the change does not appear.
- Add new UI primitives at the executor/capability layer when possible, then teach the planner about them.
- Store memories as scoped facts with evidence, not brittle click scripts or app-specific prompt hacks.
- Treat imported and negative memories as advisory until local runs prove them useful.

