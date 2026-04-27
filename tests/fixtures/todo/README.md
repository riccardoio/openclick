# todo fixture

Real `trajectory/` is recorded by hand. To populate:

```bash
open -n -g -a CuaDriver --args serve
bun bin/open42 record todo "add a checkbox task in Reminders"
# perform the task, Ctrl-C
cp -r ~/.cua/skills/todo/trajectory ./trajectory
```

Then the live eval test will compile this trajectory and assert against
`assertions.json`. The offline test asserts `expected.md` is a valid
hybrid SKILL.md.
