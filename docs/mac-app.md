# Mac App

The native macOS app is an optional wrapper around the CLI. CLI-only users can install and run `openclick` without installing the app. App installs bundle the CLI and expose the same command locally.

The Mac app includes:

- menu bar chat bar
- onboarding and permission checks
- provider/API-key settings
- task activity panel
- takeover/learning UI

For local Mac app development:

```sh
bun run build:mac-app
bun run launch:mac-app
```

CI/release Swift package commands:

```sh
swift build --package-path mac-app -c release
swift test --package-path mac-app
```

Swift products:

- `openclick-app`: native menu bar app
- `openclick-recorder`: legacy recorder executable used by the old recording workflow
- `RecorderCore`: shared recorder core library

