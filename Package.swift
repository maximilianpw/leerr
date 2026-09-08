// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Leerr",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "LeerrCore", targets: ["LeerrCore"])],
    targets: [
        .target(name: "LeerrCore"),
        .testTarget(name: "LeerrCoreTests", dependencies: ["LeerrCore"]),
    ]
)
