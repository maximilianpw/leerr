import AVFoundation
import AudioToolbox
import LeerrCore
import Observation
import UniformTypeIdentifiers

@MainActor @Observable
public final class AudioPlayer {
    public private(set) var track: Track?
    public private(set) var isPlaying = false
    public private(set) var position: TimeInterval = 0
    public private(set) var duration: TimeInterval = 0
    public private(set) var errorMessage: String?
    public private(set) var qualityDescription = PlaybackQuality().description

    // Stage 4 uses this same transport for system controls; do not create a second player.
    @ObservationIgnored let player = AVPlayer()
    @ObservationIgnored private var loader: OriginalAudioLoader?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var urlTask: Task<URL, Error>?
    @ObservationIgnored private var formatTask: Task<Void, Never>?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var timeObserver: Any?

    public init() {}

    /// Loads without autoplay. A later load or stop invalidates suspended work.
    public func load(track: Track, server: any MusicServer) async {
        guard !Task.isCancelled else { return }
        stop()
        self.track = track
        qualityDescription = PlaybackQuality(track: track).description
        let generation = self.generation
        let urlTask = Task { try await server.originalStreamURL(for: track.id) }
        self.urlTask = urlTask
        defer { if generation == self.generation { self.urlTask = nil } }
        do {
            let url = try await withTaskCancellationHandler {
                try await urlTask.value
            } onCancel: {
                urlTask.cancel()
            }
            try Task.checkCancellation()
            guard generation == self.generation else { return }
            let loader = try OriginalAudioLoader(url: url)
            self.loader = loader
            let asset = AVURLAsset(url: OriginalAudioLoader.assetURL)
            asset.resourceLoader.setDelegate(loader, queue: .main)
            let item = AVPlayerItem(asset: asset)
            observations = [
                item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == generation else { return }
                        self.refresh()
                    }
                },
                player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] _, _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.generation == generation else { return }
                        self.refresh()
                    }
                },
            ]
            player.replaceCurrentItem(with: item)
            formatTask = Task { [weak self] in
                do {
                    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
                    // Without a selected-track contract, do not choose an arbitrary
                    // track or describe mixed formats as one uniform stream.
                    guard audioTracks.count == 1 else { return }
                    let formats = try await audioTracks[0].load(.formatDescriptions)
                    try Task.checkCancellation()
                    guard let self, self.generation == generation, formats.count == 1,
                          let basic = CMAudioFormatDescriptionGetStreamBasicDescription(formats[0])?.pointee
                    else { return }
                    let codec: String?
                    switch basic.mFormatID {
                    case kAudioFormatFLAC: codec = "FLAC"
                    case kAudioFormatAppleLossless: codec = "ALAC"
                    case kAudioFormatMPEG4AAC: codec = "AAC"
                    case kAudioFormatMPEG4AAC_HE: codec = "HE-AAC"
                    case kAudioFormatMPEG4AAC_HE_V2: codec = "HE-AAC v2"
                    case kAudioFormatMPEGLayer3: codec = "MP3"
                    case kAudioFormatLinearPCM: codec = "PCM"
                    default: codec = nil
                    }
                    // ASBD bits/channel is defined for PCM, not compressed audio.
                    // This observes track samples, not decoder output or hardware.
                    let depth = basic.mFormatID == kAudioFormatLinearPCM ? Int(basic.mBitsPerChannel) : nil
                    let delivered = PlaybackQuality.Format(codec: codec, sampleRate: basic.mSampleRate,
                                                           bitDepth: depth)
                    self.qualityDescription = PlaybackQuality(track: track, delivered: delivered).description
                } catch {
                    // Optional inspection failure does not fail transport or leak
                    // URL-bearing errors. Delivered fields remain unknown.
                }
            }
            timeObserver = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.refresh()
                }
            }
        } catch {
            guard generation == self.generation else { return }
            if Task.isCancelled || error is CancellationError { stop(); return }
            errorMessage = "Unable to load this track. Check the connection and try again."
        }
    }

    public func play() {
        guard player.currentItem != nil, errorMessage == nil else { return }
        player.play()
    }

    public func pause() {
        player.pause()
        isPlaying = false
    }

    public func seek(to seconds: TimeInterval) {
        guard seconds.isFinite, player.currentItem?.status == .readyToPlay else { return }
        let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    public func stop() {
        generation = UUID()
        urlTask?.cancel()
        urlTask = nil
        formatTask?.cancel()
        formatTask = nil
        player.currentItem?.asset.cancelLoading()
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        observations.removeAll()
        player.replaceCurrentItem(with: nil)
        loader?.cancel()
        loader = nil
        track = nil
        isPlaying = false
        position = 0
        duration = 0
        errorMessage = nil
        qualityDescription = PlaybackQuality().description
    }

    private func refresh() {
        guard let item = player.currentItem else { return }
        isPlaying = player.timeControlStatus == .playing
        let seconds = player.currentTime().seconds
        if seconds.isFinite { position = max(0, seconds) }
        let length = item.duration.seconds
        if length.isFinite && length > 0 { duration = length }
        if item.status == .failed {
            player.pause()
            isPlaying = false
            // AVFoundation/URLSession errors may embed the authenticated URL.
            errorMessage = "Playback failed. The format, byte-range response, or redirect may be unsupported."
        }
        // Source metadata and asynchronously observed track formats stay separate.
        // Neither a requested original URL nor HTTP MIME certifies delivery.
    }
}

/// AVPlayer has no general-purpose HTTPS redirect veto. Never hand the original
/// authenticated URL (or an AVAssetResourceLoadingRequest.redirect) to AVPlayer.
/// Instead, serve progressive audio bytes through a custom scheme and URLSession.
/// All HTTP redirects are rejected, including same-origin redirects, deliberately
/// failing closed. HLS/playlists and servers without byte ranges are unsupported.
/// Native custom-scheme format support must still be verified on Apple platforms.
@MainActor
private final class OriginalAudioLoader: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    static let assetURL = URL(string: "leerr-audio://original/audio")!
    private let url: URL
    private let session: URLSession
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(url: URL) throws {
        guard url.scheme?.lowercased() == "https", url.host?.isEmpty == false,
              url.user == nil, url.password == nil, url.fragment == nil else {
            throw URLError(.unsupportedURL)
        }
        self.url = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration, delegate: RejectAudioRedirects(), delegateQueue: nil)
        super.init()
    }

    func cancel() {
        tasks.values.forEach { $0.cancel() }
        tasks.removeAll()
        session.invalidateAndCancel()
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        guard request.request.url == Self.assetURL else {
            request.finishLoading(with: URLError(.unsupportedURL))
            return true
        }
        let id = ObjectIdentifier(request)
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.tasks[id] = nil }
            do {
                try await self.supply(request)
                if !request.isCancelled { request.finishLoading() }
            } catch {
                if !request.isCancelled {
                    request.finishLoading(with: URLError(.cannotLoadFromNetwork))
                }
            }
        }
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        didCancel request: AVAssetResourceLoadingRequest) {
        tasks.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }

    private func supply(_ loading: AVAssetResourceLoadingRequest) async throws {
        let dataRequest = loading.dataRequest
        var offset = dataRequest?.currentOffset ?? 0
        let requestedEnd: Int64?
        if let dataRequest, !dataRequest.requestsAllDataToEndOfResource {
            requestedEnd = try OriginalAudioRange.requestedEnd(
                offset: dataRequest.requestedOffset, length: dataRequest.requestedLength)
        } else {
            requestedEnd = nil
        }
        var expectedTotal: Int64?
        repeat {
            try Task.checkCancellation()
            // Range-compliant servers return at most 1 MiB per request. This is
            // not a response-size security limit against a malicious server.
            if offset == requestedEnd { return }
            let range = try OriginalAudioRange(offset: offset, requestedEnd: requestedEnd)
            var request = URLRequest(url: url)
            request.setValue(range.header, forHTTPHeaderField: "Range")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let (data, response) = try await session.data(for: request)
            try Task.checkCancellation()
            guard !loading.isCancelled,
                  let response = response as? HTTPURLResponse,
                  response.statusCode == 206,
                  let contentRange = response.value(forHTTPHeaderField: "Content-Range"),
                  let mime = response.mimeType,
                  ["audio/flac", "audio/x-flac", "audio/mpeg", "audio/mp4", "audio/aac",
                   "audio/wav", "audio/x-wav", "audio/aiff", "audio/x-aiff"].contains(mime),
                  let type = UTType(mimeType: mime) else { throw URLError(.badServerResponse) }
            let validated = try range.validate(contentRange: contentRange, byteCount: data.count,
                                               expectedTotal: expectedTotal)
            expectedTotal = validated.total
            if let info = loading.contentInformationRequest {
                info.contentType = type.identifier
                info.contentLength = validated.total
                info.isByteRangeAccessSupported = true
            }
            guard let dataRequest else { return }
            dataRequest.respond(with: data)
            offset = validated.nextOffset
            if offset >= validated.total { return }
        } while offset < (requestedEnd ?? Int64.max)
    }
}

private final class RejectAudioRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Applies to every range fetch, not a preflight that AVPlayer can bypass.
        completionHandler(nil)
    }
}
