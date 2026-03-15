// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "CoworkLoomBridge",
    platforms: [
        .macOS(.v14),
        .iOS("17.4"),
    ],
    products: [
        .library(
            name: "CoworkLoomRelayCore",
            targets: ["CoworkLoomRelayCore"]
        ),
        .library(
            name: "CoworkLoomRelayClient",
            targets: ["CoworkLoomRelayClient"]
        ),
        .executable(
            name: "cowork-loom-bridge",
            targets: ["cowork-loom-bridge"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/EthanLipnik/Loom.git", exact: "1.5.0"),
    ],
    targets: [
        .target(
            name: "CoworkLoomRelayCore"
        ),
        .target(
            name: "CoworkLoomRelayClient",
            dependencies: [
                "CoworkLoomRelayCore",
                .product(name: "Loom", package: "Loom"),
            ]
        ),
        .target(
            name: "CoworkLoomRelayHost",
            dependencies: [
                "CoworkLoomRelayCore",
                .product(name: "Loom", package: "Loom"),
            ]
        ),
        .executableTarget(
            name: "cowork-loom-bridge",
            dependencies: ["CoworkLoomRelayHost"]
        ),
        .testTarget(
            name: "CoworkLoomRelayCoreTests",
            dependencies: ["CoworkLoomRelayCore"]
        ),
        .testTarget(
            name: "CoworkLoomRelayHostTests",
            dependencies: ["CoworkLoomRelayHost"]
        ),
    ]
)
