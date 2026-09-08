import AVFoundation
import Foundation
import LeerrCore
import MediaPlayer
import Observation

/// One instance per app process. Route UI transport actions through this owner,
/// and call stop() before replacing an account or server.
@MainActor @Observable
final class PlaybackController {
    let audio = AudioPlayer()
    private(set) var queue = PlaybackQueue()
    private(set) var errorMessage: String?
    /// Includes buffering/preparation so the UI can pause a pending play intent.
    var isPlaybackRequested: Bool { wantsPlayback }

    @ObservationIgnored private var server: (any MusicServer)?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var generation = UUID()
    private var wantsPlayback = false
    @ObservationIgnored private var interrupted = false
    @ObservationIgnored private var resumeAfterInterruption = false
    @ObservationIgnored private var registrations: PlaybackRegistrations?

    init() {
        let registrations = PlaybackRegistrations(player: audio.player)
        self.registrations = registrations
        registrations.timeObserver = audio.player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateNowPlaying() }
        }
        registrations.notifications.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let self, let item = notification.object as? AVPlayerItem,
                      item === self.audio.player.currentItem else { return }
                let generation = self.generation
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation, self.wantsPlayback,
                          !self.interrupted else { return }
                    await self.next()
                }
            }
        })
        registerRemoteCommands(registrations)
        #if os(iOS)
        registrations.notifications.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated { self?.handleInterruption(notification) }
        })
        registrations.notifications.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] notification in
            MainActor.assumeIsolated {
                guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
                self?.pause()
            }
        })
        #endif
        updateNowPlaying()
        observeAudioState()
    }

    deinit {
        loadTask?.cancel()
        // Swift 6 deinitializers are not actor-isolated; remove Apple callbacks
        // on the actor that registered them, without retaining this controller.
        let registrations = registrations
        Task { @MainActor in registrations?.remove() }
    }

    func start(tracks: [Track], index: Int, server: any MusicServer) async {
        stop()
        queue = PlaybackQueue(tracks: tracks, index: index)
        guard queue.current != nil else { return }
        self.server = server
        await loadCurrent()
    }

    func next() async {
        guard queue.next() != nil else {
            pause()
            return
        }
        await loadCurrent()
    }

    /// Previous restarts after three seconds; otherwise selects the prior entry.
    func previous() async {
        if audio.position > 3 || !queue.hasPrevious {
            seek(to: 0)
            return
        }
        queue.previous()
        await loadCurrent()
    }

    func retry() async {
        guard queue.current != nil, server != nil else { return }
        await loadCurrent(resumeAt: audio.position)
    }

    func play() {
        guard queue.current != nil else { return }
        wantsPlayback = true
        guard !interrupted, activateSession() else { return }
        if audio.duration > 0, audio.position >= audio.duration { audio.seek(to: 0) }
        audio.play()
        updateNowPlaying()
    }

    func pause() {
        wantsPlayback = false
        resumeAfterInterruption = false
        audio.pause()
        updateNowPlaying()
    }

    func seek(to position: TimeInterval) {
        guard position.isFinite, queue.current != nil else { return }
        audio.seek(to: max(0, audio.duration > 0 ? min(position, audio.duration) : position))
        updateNowPlaying()
    }

    func stop() {
        generation = UUID()
        loadTask?.cancel()
        loadTask = nil
        wantsPlayback = false
        resumeAfterInterruption = false
        server = nil
        queue = PlaybackQueue()
        errorMessage = nil
        audio.stop()
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        updateNowPlaying()
    }

    private func loadCurrent(resumeAt: TimeInterval? = nil) async {
        guard let track = queue.current, let server else { return }
        loadTask?.cancel()
        audio.stop()
        let generation = UUID()
        self.generation = generation
        wantsPlayback = true
        resumeAfterInterruption = false
        errorMessage = nil
        updateNowPlaying()
        let audio = audio
        let task = Task {
            guard !Task.isCancelled else { return }
            await audio.load(track: track, server: server)
        }
        loadTask = task
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        guard self.generation == generation else { return }
        loadTask = nil
        guard !Task.isCancelled, !task.isCancelled else {
            wantsPlayback = false
            audio.stop()
            updateNowPlaying()
            return
        }
        if let resumeAt, audio.errorMessage == nil { audio.seek(to: resumeAt) }
        if audio.errorMessage == nil, wantsPlayback, !interrupted { play() }
        updateNowPlaying()
    }

    private func activateSession() -> Bool {
        #if os(iOS)
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
            errorMessage = nil
        } catch {
            errorMessage = "Audio output is unavailable. Try playing again."
            wantsPlayback = false
            return false
        }
        #endif
        return true
    }

    #if os(iOS)
    private func handleInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            resumeAfterInterruption = wantsPlayback && audio.isPlaying
            interrupted = true
            audio.pause()
            updateNowPlaying()
        case .ended:
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
            interrupted = false
            let resume = resumeAfterInterruption && wantsPlayback && shouldResume
            resumeAfterInterruption = false
            if resume { play() } else { pause() }
        @unknown default:
            pause()
        }
    }
    #endif

    private func registerRemoteCommands(_ registrations: PlaybackRegistrations) {
        let center = MPRemoteCommandCenter.shared()
        registrations.add(center.playCommand) { [weak self] in self?.play() }
        registrations.add(center.pauseCommand) { [weak self] in self?.pause() }
        registrations.add(center.stopCommand) { [weak self] in self?.stop() }
        registrations.add(center.togglePlayPauseCommand) { [weak self] in
            guard let self else { return }
            if self.wantsPlayback { self.pause() } else { self.play() }
        }
        registrations.add(center.nextTrackCommand) { [weak self] in await self?.next() }
        registrations.add(center.previousTrackCommand) { [weak self] in await self?.previous() }
        let token = center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            Task { @MainActor [weak self] in self?.seek(to: position) }
            return .success
        }
        registrations.commands.append((center.changePlaybackPositionCommand, token))
        center.skipForwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.preferredIntervals = [15]
        for (command, direction) in [(center.skipForwardCommand, 1.0), (center.skipBackwardCommand, -1.0)] {
            let token = command.addTarget { [weak self] event in
                guard let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
                let delta = event.interval * direction
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.seek(to: self.audio.position + delta)
                }
                return .success
            }
            registrations.commands.append((command, token))
        }
    }

    /// A periodic time callback alone misses transitions while the clock is
    /// stopped (buffering, errors, and readiness after an explicit pause).
    private func observeAudioState() {
        withObservationTracking {
            _ = audio.track
            _ = audio.isPlaying
            _ = audio.duration
            _ = audio.errorMessage
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.updateNowPlaying()
                self?.observeAudioState()
            }
        }
    }

    private func updateNowPlaying() {
        let commands = MPRemoteCommandCenter.shared()
        let hasTrack = queue.current != nil
        commands.playCommand.isEnabled = hasTrack
        commands.pauseCommand.isEnabled = hasTrack
        commands.stopCommand.isEnabled = hasTrack
        commands.togglePlayPauseCommand.isEnabled = hasTrack
        commands.nextTrackCommand.isEnabled = queue.hasNext
        commands.previousTrackCommand.isEnabled = hasTrack
        commands.changePlaybackPositionCommand.isEnabled = hasTrack && audio.duration > 0
        commands.skipForwardCommand.isEnabled = hasTrack && audio.duration > 0
        commands.skipBackwardCommand.isEnabled = hasTrack && audio.duration > 0
        let center = MPNowPlayingInfoCenter.default()
        guard let track = audio.track, hasTrack else {
            center.nowPlayingInfo = nil
            #if os(macOS)
            center.playbackState = .stopped
            #endif
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: audio.position,
            MPNowPlayingInfoPropertyPlaybackRate: audio.isPlaying ? 1.0 : 0.0,
        ]
        if audio.duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = audio.duration }
        center.nowPlayingInfo = info
        #if os(macOS)
        center.playbackState = audio.isPlaying ? .playing : .paused
        #endif
    }
}

/// Keeps non-Sendable observer handles on the main actor during teardown.
@MainActor
private final class PlaybackRegistrations {
    let player: AVPlayer
    var timeObserver: Any?
    var notifications: [NSObjectProtocol] = []
    var commands: [(MPRemoteCommand, Any)] = []

    init(player: AVPlayer) { self.player = player }

    func add(_ command: MPRemoteCommand, action: @escaping @MainActor @Sendable () async -> Void) {
        let token = command.addTarget { _ in
            Task { @MainActor in await action() }
            return .success
        }
        commands.append((command, token))
    }

    func remove() {
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        for token in notifications { NotificationCenter.default.removeObserver(token) }
        notifications.removeAll()
        for (command, token) in commands {
            command.removeTarget(token)
            command.isEnabled = false
        }
        commands.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        #if os(macOS)
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        #endif
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}
