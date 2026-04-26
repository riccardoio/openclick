// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "showme-recorder",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "showme-recorder", targets: ["Recorder"]),
    .executable(name: "showme-bar", targets: ["ShowmeBar"]),
    .library(name: "RecorderCore", targets: ["RecorderCore"]),
  ],
  targets: [
    .executableTarget(name: "Recorder", dependencies: ["RecorderCore"]),
    .executableTarget(name: "ShowmeBar"),
    .target(name: "RecorderCore"),
    .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
  ]
)
