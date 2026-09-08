import SwiftUI
import LeerrCore

@main
struct LeerrApp: App {
    @State private var model = LeerrModel()

    var body: some Scene {
        WindowGroup {
            LeerrRootView(model: model)
        }
    }
}
