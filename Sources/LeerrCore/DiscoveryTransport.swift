import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DiscoveryHTTPResponse: Sendable {
    public let data: Data
    public let statusCode: Int

    public init(data: Data, statusCode: Int = 200) {
        self.data = data
        self.statusCode = statusCode
    }
}

/// Fixtures receive requests but must not log them: Last.fm URLs contain API keys.
public protocol DiscoveryTransport: Sendable {
    func send(_ request: URLRequest) async throws -> DiscoveryHTTPResponse
}

public final class DiscoveryURLSessionTransport: DiscoveryTransport {
    private let session: URLSession

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration, delegate: DiscoveryRedirectPolicy(), delegateQueue: nil)
    }

    public func send(_ request: URLRequest) async throws -> DiscoveryHTTPResponse {
        guard request.url?.scheme == "https" else { throw DiscoveryError.invalidConfiguration }
        do {
            let (data, response) = try await session.data(for: request)
            try Task.checkCancellation()
            guard let response = response as? HTTPURLResponse else { throw DiscoveryError.invalidResponse }
            return DiscoveryHTTPResponse(data: data, statusCode: response.statusCode)
        } catch {
            throw safeDiscoveryError(error)
        }
    }
}

/// No redirect can leak a Last.fm key, even to another HTTPS origin.
final class DiscoveryRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

func safeDiscoveryError(_ error: Error) -> Error {
    if error is CancellationError || Task.isCancelled || (error as? URLError)?.code == .cancelled {
        return CancellationError()
    }
    return error as? DiscoveryError ?? DiscoveryError.transport
}

func discoveryData(_ request: URLRequest, transport: any DiscoveryTransport) async throws -> Data {
    try Task.checkCancellation()
    do {
        let response = try await transport.send(request)
        try Task.checkCancellation()
        switch response.statusCode {
        case 200..<300: return response.data
        case 401, 403: throw DiscoveryError.authentication
        case 404: throw DiscoveryError.notFound
        case 429: throw DiscoveryError.rateLimited
        case 500...599: throw DiscoveryError.unavailable
        default: throw DiscoveryError.invalidResponse
        }
    } catch { throw safeDiscoveryError(error) }
}

func discoveryDecode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) }
    catch { throw DiscoveryError.invalidResponse }
}
