// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "openclick-helper",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "openclick-recorder", targets: ["Recorder"]),
    .executable(name: "OpenclickHelper", targets: ["OpenclickHelper"]),
    .library(name: "RecorderCore", targets: ["RecorderCore"]),
  ],
  targets: [
    .executableTarget(name: "Recorder", dependencies: ["RecorderCore"]),
    .executableTarget(name: "OpenclickHelper", exclude: ["Info.plist"]),
    .target(name: "RecorderCore"),
    .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
  ]
)
