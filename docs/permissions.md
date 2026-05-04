# macOS Permissions

OpenClick acts through `OpenclickHelper`, a signed helper app with bundle ID
`com.openclick.helper`. Grant permissions to `OpenclickHelper`, not to an old
`CuaDriver` entry or a standalone binary.

Run:

```sh
openclick setup
```

The helper window guides you through:

| Permission | Why It Is Needed |
| --- | --- |
| Accessibility | Lets OpenclickHelper inspect UI structure and send clicks or keystrokes. |
| Screen Recording | Lets OpenclickHelper capture screenshots while a task is running. |
| Automation / Apple Events | Used only when a target app requires Apple Events for the requested action. |
| Full Disk Access | Needed only for protected migration cleanup on some Macs. |
| Developer Tools / SIP | Needed only on managed or developer-locked Macs that require it. |

The window opens the correct System Settings pane and polls every half second.
When macOS reports a grant, the window advances automatically. If a permission is
still waiting after 60 seconds, use the Retry button; setup does not auto-abort.

## Migration From CuaDriver

The new helper uses a new bundle ID, so old `CuaDriver` permissions do not carry
over. On first run after upgrading, OpenclickHelper detects old installs such as
`/Applications/CuaDriver.app`, stale `com.trycua.driver` TCC rows, and running
`cua-driver serve` processes. The migration step offers safe cleanup actions:
move the old app to Trash, reset stale TCC entries, and stop the old daemon.

## Recovery

If a run reports missing permissions:

```sh
openclick setup
```

If you want a diagnostic report instead:

```sh
openclick doctor
```
