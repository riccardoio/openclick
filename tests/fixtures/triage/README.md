# triage fixture

Real `trajectory/` for this fixture is recorded by hand against a public GitHub
repo (e.g. `farzaa/clicky/issues`). To populate:

```bash
open -n -g -a CuaDriver --args serve
bun bin/open42 record triage-issues "triage 3 issues in farzaa/clicky"
# perform the task, Ctrl-C
cp -r ~/.cua/skills/triage-issues/trajectory ./trajectory
```

Then the live eval test (`bun test tests/eval.test.ts` with `ANTHROPIC_API_KEY`
set) will compile this trajectory and assert against `assertions.json`. The
offline structure test asserts that `expected.md` is a valid hybrid SKILL.md.
