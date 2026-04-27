// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "open42-recorder",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "open42-recorder", targets: ["Recorder"]),
    .executable(name: "open42-app", targets: ["Open42App"]),
    .library(name: "RecorderCore", targets: ["RecorderCore"]),
  ],
  targets: [
    .executableTarget(name: "Recorder", dependencies: ["RecorderCore"]),
    .executableTarget(name: "Open42App"),
    .target(name: "RecorderCore"),
    .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
  ]
)
