import AppKit
import CoreGraphics
import Foundation
import Vision

@main
struct LeerrUI {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            usage()
            exit(2)
        }
        do {
            switch command {
            case "windows":
                try windows(Array(args.dropFirst()))
            case "ocr":
                try ocr(Array(args.dropFirst()))
            default:
                usage()
                exit(2)
            }
        } catch {
            fputs("leerr-ui: \(error)\n", stderr)
            exit(1)
        }
    }

    static func usage() {
        fputs(
            """
            usage: leerr-ui windows --pid <pid>
                   leerr-ui ocr --path <png> [--contains <text>]...

            """,
            stderr
        )
    }

    static func windows(_ args: [String]) throws {
        let pid = try requiredInt(args, flag: "--pid")
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]
        else {
            throw CLIError("failed to copy window list")
        }
        var found = false
        for window in info {
            let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t ?? 0
            guard Int(ownerPID) == pid else { continue }
            found = true
            let id = window[kCGWindowNumber as String] as? Int ?? 0
            let name = window[kCGWindowName as String] as? String ?? ""
            let owner = window[kCGWindowOwnerName as String] as? String ?? ""
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
            let x = intValue(bounds["X"])
            let y = intValue(bounds["Y"])
            let w = intValue(bounds["Width"])
            let h = intValue(bounds["Height"])
            print("id=\(id) name=\(escape(name)) owner=\(escape(owner)) layer=\(layer) x=\(x) y=\(y) w=\(w) h=\(h)")
        }
        if !found {
            throw CLIError("no on-screen windows for pid \(pid)")
        }
    }

    static func ocr(_ args: [String]) throws {
        let path = try requiredValue(args, flag: "--path")
        let expected = values(args, flag: "--contains")
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            throw CLIError("image not found: \(path)")
        }
        guard let image = NSImage(contentsOf: url),
              let tiff = image.tiffRepresentation,
              let ciImage = CIImage(data: tiff)
        else {
            throw CLIError("could not read image: \(path)")
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let handler = VNImageRequestHandler(ciImage: ciImage)
        try handler.perform([request])
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        for line in lines {
            print(line)
        }

        let haystack = lines.joined(separator: " ")
        var missing: [String] = []
        for needle in expected where haystack.range(of: needle, options: .caseInsensitive) == nil {
            missing.append(needle)
        }
        if !missing.isEmpty {
            throw CLIError("OCR missing expected text: \(missing.joined(separator: " | "))")
        }
    }

    static func requiredValue(_ args: [String], flag: String) throws -> String {
        guard let value = values(args, flag: flag).last else {
            throw CLIError("missing \(flag)")
        }
        return value
    }

    static func requiredInt(_ args: [String], flag: String) throws -> Int {
        let raw = try requiredValue(args, flag: flag)
        guard let value = Int(raw) else {
            throw CLIError("\(flag) must be an integer")
        }
        return value
    }

    static func values(_ args: [String], flag: String) -> [String] {
        var result: [String] = []
        var index = 0
        while index < args.count {
            if args[index] == flag {
                let next = index + 1
                if next < args.count {
                    result.append(args[next])
                    index = next
                }
            }
            index += 1
        }
        return result
    }

    static func intValue(_ raw: Any?) -> Int {
        if let number = raw as? NSNumber {
            return number.intValue
        }
        if let value = raw as? Int {
            return value
        }
        if let value = raw as? Double {
            return Int(value)
        }
        return 0
    }

    static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: " ", with: "\\ ")
    }

    struct CLIError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
