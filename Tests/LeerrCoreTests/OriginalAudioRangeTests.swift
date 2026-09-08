import Testing
@testable import LeerrCore

@Test func rangesUseExclusiveEndsAndBoundChunks() throws {
    #expect(try OriginalAudioRange.requestedEnd(offset: 17, length: 5) == 22)
    #expect(try OriginalAudioRange.requestedEnd(offset: 17, length: 0) == 17)
    let small = try OriginalAudioRange(offset: 17, requestedEnd: 22)
    #expect(small.header == "bytes=17-21")
    #expect(try OriginalAudioRange(offset: 17).end == 1_048_593)
    let result = try small.validate(contentRange: "bytes 17-21/93", byteCount: 5)
    #expect(result.nextOffset == 22)
    #expect(result.total == 93)
    let short = try small.validate(contentRange: "bytes 17-19/20", byteCount: 3)
    #expect(short.nextOffset == 20)
    #expect(short.total == 20)
}

@Test func requestArithmeticRejectsOverflowAndInvalidBounds() throws {
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try OriginalAudioRange.requestedEnd(offset: .max, length: 1)
    }
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try OriginalAudioRange.requestedEnd(offset: -1, length: 3)
    }
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try OriginalAudioRange.requestedEnd(offset: 3, length: -1)
    }
    #expect(try OriginalAudioRange.requestedEnd(offset: .max - 1, length: 1) == .max)
    for (offset, end): (Int64, Int64?) in [(-1, nil), (.max, nil), (3, 3), (4, 3), (0, -1)] {
        #expect(throws: OriginalAudioRange.ValidationError.self) {
            try OriginalAudioRange(offset: offset, requestedEnd: end)
        }
    }
    let last = try OriginalAudioRange(offset: .max - 2)
    #expect(last.end == .max)
    #expect(last.header == "bytes=9223372036854775805-9223372036854775806")
    let response = try last.validate(contentRange: "bytes 9223372036854775805-9223372036854775806/9223372036854775807", byteCount: 2)
    #expect(response.nextOffset == .max)
}

@Test(arguments: [
    "bytes 16-20/93", "bytes 18-21/93", "bytes 17-22/93", "bytes 17-16/93",
    "bytes 17-21/21", "bytes 17-21/0", "bytes -17-21/93", "bytes 17--21/93",
    "bytes +17-21/93", "bytes 17-21/-93", "bytes 17-21/*", "bytes */93",
    "bytes 17-21/9223372036854775808", "bytes 17-9223372036854775807/9223372036854775807",
    "bytes 17-21/93/94", "bytes 17-21/93 ", "bytes 17-21/", "bytes /93",
    "items 17-21/93", "bytes 17-21/93, 22-25/93",
])
func rejectsInvalidContentRange(header: String) throws {
    let range = try OriginalAudioRange(offset: 17, requestedEnd: 22)
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try range.validate(contentRange: header, byteCount: 5)
    }
}

@Test(arguments: [-1, 0, 4, 6, Int.max])
func rejectsWrongBodyCount(count: Int) throws {
    let range = try OriginalAudioRange(offset: 17, requestedEnd: 22)
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try range.validate(contentRange: "bytes 17-21/93", byteCount: count)
    }
}

@Test func rejectsChangingResourceLength() throws {
    let range = try OriginalAudioRange(offset: 17, requestedEnd: 22)
    #expect(try range.validate(contentRange: "bytes 17-21/93", byteCount: 5, expectedTotal: 93).total == 93)
    #expect(throws: OriginalAudioRange.ValidationError.self) {
        try range.validate(contentRange: "bytes 17-21/94", byteCount: 5, expectedTotal: 93)
    }
}
