# Mac App

The native SwiftPM executable target is `OpenclickHelper`. Release builds are
packaged as:

```text
OpenclickHelper.app
└── Contents/MacOS/OpenclickHelper
```

Bundle identity:

- Bundle ID: `com.openclick.helper`
- Minimum macOS: 13.0
- Entitlement: `com.apple.security.automation.apple-events`

The helper app owns the macOS permission identity. The CLI always launches the
daemon through the full bundle executable path, for example:

```text
/Applications/OpenclickHelper.app/Contents/MacOS/OpenclickHelper
```

For local Mac app development:

```sh
bun run build:mac-app
bun run launch:mac-app
```

Release scaffolding:

```sh
scripts/build-universal.sh
scripts/sign-and-notarize.sh
```

The signing script reads variable names from `~/.openclick/signing.env`; do not
store signing credentials in the repo.

Swift products:

- `OpenclickHelper`: helper app and permission setup window
- `openclick-recorder`: legacy recorder executable used by the old recording workflow
- `RecorderCore`: shared recorder core library
