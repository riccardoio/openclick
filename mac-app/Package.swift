// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "openclick-recorder",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "openclick-recorder", targets: ["Recorder"]),
    .executable(name: "openclick-app", targets: ["OpenClickApp"]),
    .library(name: "RecorderCore", targets: ["RecorderCore"]),
  ],
  targets: [
    .executableTarget(name: "Recorder", dependencies: ["RecorderCore"]),
    .executableTarget(name: "OpenClickApp"),
    .target(name: "RecorderCore"),
    .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
  ]
)
