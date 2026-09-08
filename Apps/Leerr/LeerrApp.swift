import SwiftUI
import LeerrCore

@main
struct LeerrApp: App {
    var body: some Scene {
        WindowGroup {
            ContentUnavailableView {
                Label("Leerr", systemImage: "music.note.house")
            } description: {
                Text("Your music, from your server.\nNavidrome connection and playback are coming next.")
            }
        }
    }
}
