import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Safe to display: no associated URLs, response bodies, or underlying errors.
public enum MusicServerError: Error, Equatable, Sendable, LocalizedError {
    case authentication
    case transport
    case unavailable
    case invalidResponse
    case invalidRequest
    case unsafeRedirect
    case server(code: Int)

    public var errorDescription: String? {
        switch self {
        case .authentication: "Check your username and password."
        case .transport: "The server could not be reached securely."
        case .unavailable: "The server is currently unavailable."
        case .invalidResponse: "The server returned an unsupported response."
        case .invalidRequest: "The request parameters are invalid."
        case .unsafeRedirect: "The server redirected the request to an unsafe destination."
        case .server: "The server could not complete the request."
        }
    }
}

public struct HTTPResponse: Sendable {
    public let data: Data
    public let statusCode: Int

    public init(data: Data, statusCode: Int) {
        self.data = data
        self.statusCode = statusCode
    }
}

/// Injected transports must preserve cancellation and enforce HTTPS/redirect policy.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResponse
}

/// Ephemeral session: no persistent cookies, credentials or authenticated URL cache.
public struct URLSessionHTTPTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> HTTPResponse {
        try Task.checkCancellation()
        guard let url = request.url, url.scheme?.lowercased() == "https",
              url.host != nil, url.user == nil, url.password == nil else {
            throw MusicServerError.invalidRequest
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: configuration, delegate: SecureRedirectDelegate(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await session.data(for: request)
            try Task.checkCancellation()
            guard let response = response as? HTTPURLResponse else {
                throw MusicServerError.invalidResponse
            }
            guard let finalURL = response.url, Self.permitsRedirect(from: url, to: finalURL),
                  !(300..<400).contains(response.statusCode) else {
                throw MusicServerError.unsafeRedirect
            }
            return HTTPResponse(data: data, statusCode: response.statusCode)
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            if let safe = error as? MusicServerError { throw safe }
            throw MusicServerError.transport
        }
    }

    static func permitsRedirect(from source: URL, to target: URL, method: String = "GET") -> Bool {
        (method == "GET" || method == "HEAD")
            && source.scheme?.lowercased() == "https" && target.scheme?.lowercased() == "https"
            && source.host?.lowercased() == target.host?.lowercased()
            && (source.port ?? 443) == (target.port ?? 443)
            && target.user == nil && target.password == nil
    }
}

private final class SecureRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        guard let source = task.originalRequest?.url, let target = request.url,
              URLSessionHTTPTransport.permitsRedirect(from: source, to: target,
                  method: task.originalRequest?.httpMethod ?? "GET") else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
