/// A bounded, nonempty HTTP byte request with an exclusive end offset.
/// Validation requires a single 206 Content-Range with a known resource length.
public struct OriginalAudioRange: Equatable, Sendable {
    public enum ValidationError: Error { case invalidRequest, invalidResponse }

    public let start: Int64
    public let end: Int64
    public var header: String { "bytes=\(start)-\(end - 1)" }

    public static func requestedEnd(offset: Int64, length: Int) throws -> Int64 {
        guard offset >= 0, length >= 0, let length = Int64(exactly: length) else {
            throw ValidationError.invalidRequest
        }
        let (end, overflow) = offset.addingReportingOverflow(length)
        guard !overflow else { throw ValidationError.invalidRequest }
        return end
    }

    public init(offset: Int64, requestedEnd: Int64? = nil) throws {
        let limit = requestedEnd ?? Int64.max
        guard offset >= 0, offset < limit else { throw ValidationError.invalidRequest }
        start = offset
        // Subtract first: neither the remaining length nor the sum can overflow.
        end = offset + min(1_048_576, limit - offset)
    }

    /// Returns the next offset and total only after all response bounds agree.
    /// Short responses are accepted; the caller continues from nextOffset.
    public func validate(contentRange: String, byteCount: Int,
                         expectedTotal: Int64? = nil) throws -> (nextOffset: Int64, total: Int64) {
        guard contentRange.hasPrefix("bytes ") else { throw ValidationError.invalidResponse }
        let halves = contentRange.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
        guard halves.count == 2 else { throw ValidationError.invalidResponse }
        let bounds = halves[0].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2 else { throw ValidationError.invalidResponse }
        let fields = [bounds[0], bounds[1], halves[1]]
        guard fields.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }),
              let first = Int64(fields[0]), let last = Int64(fields[1]), let total = Int64(fields[2]),
              first == start, last >= first, last < end, last < total,
              expectedTotal == nil || expectedTotal == total,
              let count = Int64(exactly: byteCount), count == last - first + 1 else {
            throw ValidationError.invalidResponse
        }
        // last < end <= Int64.max proves this addition safe.
        return (last + 1, total)
    }
}
