import Foundation
import Observation

/// The app clears playback and feature state before beginning a new connection.
@MainActor @Observable
public final class ConnectionSession {
    public private(set) var server: (any MusicServer)?
    public private(set) var isConnecting = false
    public private(set) var errorMessage: String?
    @ObservationIgnored private var attempt: Task<Void, Error>?
    @ObservationIgnored private var generation = 0

    public init() {}

    @discardableResult
    public func connect(to candidate: any MusicServer) async -> Bool {
        disconnect()
        let current = generation
        isConnecting = true
        let task = Task { try await candidate.connect() }
        attempt = task
        do {
            try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            guard current == generation else { return false }
            try Task.checkCancellation()
            guard !task.isCancelled else { throw CancellationError() }
            server = candidate
            isConnecting = false
            attempt = nil
            return true
        } catch {
            guard current == generation else { return false }
            isConnecting = false
            attempt = nil
            if !(error is CancellationError) && !Task.isCancelled && !task.isCancelled {
                errorMessage = "Could not connect. Check the HTTPS address and credentials, then retry."
            }
            return false
        }
    }

    public func disconnect() {
        generation += 1
        attempt?.cancel()
        attempt = nil
        server = nil
        isConnecting = false
        errorMessage = nil
    }
}
