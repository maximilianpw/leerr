import Testing
@testable import LeerrCore

private let queueTracks = [
    Track(id: "same", title: "First", artist: "A", duration: 90),
    Track(id: "middle", title: "Second", artist: "B", duration: 130),
    Track(id: "same", title: "Third", artist: "C", duration: nil),
]

@Test func queueStartsAtRequestedIndexAndPreservesDuplicates() {
    var queue = PlaybackQueue(tracks: queueTracks, index: 1)
    #expect(queue.current == queueTracks[1])
    #expect(queue.hasPrevious && queue.hasNext)
    #expect(queue.next() == queueTracks[2])
    #expect(queue.index == 2)
    #expect(queue.next() == nil)
    #expect(queue.current == queueTracks[2])
    #expect(!queue.hasNext)
    #expect(queue.previous() == queueTracks[1])
    #expect(queue.previous() == queueTracks[0])
    #expect(queue.previous() == nil)
    #expect(queue.index == 0)
    #expect(!queue.hasPrevious)
}

@Test(arguments: [-1, 3, Int.max])
func invalidQueueSelectionClearsTracks(index: Int) {
    let queue = PlaybackQueue(tracks: queueTracks, index: index)
    #expect(queue == PlaybackQueue())
}

@Test func emptyAndSingleTrackQueuesDoNotWrap() {
    var empty = PlaybackQueue(tracks: [], index: 0)
    #expect(empty.current == nil)
    #expect(empty.next() == nil)
    #expect(empty.previous() == nil)
    var single = PlaybackQueue(tracks: [queueTracks[1]], index: 0)
    #expect(single.next() == nil)
    #expect(single.previous() == nil)
    #expect(single.current == queueTracks[1])
    single = PlaybackQueue()
    #expect(single.tracks.isEmpty)
    #expect(single.index == nil)
}
