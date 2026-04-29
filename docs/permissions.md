# macOS Permissions

OpenClick acts on the local desktop, so macOS must allow it to inspect and control UI state. The onboarding screen and `openclick doctor` check these permissions.

Enable these in System Settings > Privacy & Security:

| Permission | Simple Explanation | Why OpenClick Needs It |
| --- | --- | --- |
| Accessibility | Lets OpenClick use your Mac like an assistant using the keyboard and mouse. | Lets OpenClick and `cua-driver` inspect accessible UI elements, focus windows, press buttons, type, click, and use AX-backed app controls. Without it, OpenClick cannot reliably act inside other apps. |
| Screen Recording | Lets OpenClick see what is on your screen so it can understand whether the task is working. | Lets OpenClick capture screenshots for visual state, verification, progress checks, stuck-state detection, and takeover learning. Without it, the planner and verifier lose the evidence they need to know what happened. |

Also required:

- Model API key: Anthropic or OpenAI is required for planning, verification, result summaries, and compile flows. Keys saved through the Mac app are stored in Keychain and shown only as asterisks.
- `cua-driver` helper: the small local helper that safely performs desktop actions for OpenClick. OpenClick starts it automatically when possible; users should not need to start it manually.

Grant permissions to the app/process macOS shows for the way you run OpenClick:

- Native app: grant permissions to the OpenClick app.
- CLI development: grant permissions to the terminal app, Bun, or the `cua-driver` helper if macOS prompts for those.

After rebuilding a local app binary, macOS may require granting permissions again because the binary identity changed.
