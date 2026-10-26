# Leerr: a personal record shop

## Direction

Leerr is a collection to live with, not an administration dashboard. The rebuilt interface uses warm paper, ink, a rust-red accent, editorial serif headings, locally hosted Inter, and square album sleeves. A quieter shell keeps discovery, collecting, requesting, and listening distinct without hiding the connections between them.

The existing Plex playback, queue, favourites, playlists, MusicBrainz search and edition selection, Lidarr requests, authentication, and administration remain. No production data or integration contracts were reset.

## Reference research

Research used Mobbin through Executor's `mobbin_mcp` integration: 26 screen results and four flow results spanning desktop discovery, collections, album detail, queues, mobile listening, playlist additions, variant selection, and progress tracking. Selected screen previews and enlarged references informed the direction; this is a synthesis, not a reproduction of any one app.

| Reference | Applied principle |
| --- | --- |
| [Apple Music discovery](https://mobbin.com/screens/a917d88f-d15a-4f53-92d3-1daecf59d05f) | A strong editorial lead followed by smaller, useful shelves. |
| [Record Club collection](https://mobbin.com/screens/53fd0257-8ad0-4b7b-abc6-a29236257ca8) | Square sleeves, generous rhythm, collection tabs and restrained filters. |
| [Record Club detail](https://mobbin.com/screens/d6b84ad3-294d-48c8-9580-bfdd900c9095) | Artwork-led album hierarchy. |
| [Deezer queue](https://mobbin.com/screens/df7d4a58-5a6d-4bae-bf3f-e3d299abbda2) | Quiet, readable track rows and clear current-track selection. |
| [TIDAL album and queue](https://mobbin.com/screens/dc12eb80-5356-4401-a0f5-07251bfd1ae7) | Album actions and persistent listening context. |
| [Spotify discovery](https://mobbin.com/screens/4429f42c-8e9a-4084-9a2e-3887e8c92e48) | Separate discovery and collection navigation. |
| [Spotify mobile queue](https://mobbin.com/screens/42c348f8-02f5-46f3-b946-82ef07ed899e) | A vertically ordered queue on constrained screens. |
| [Spotify playlist-add flow](https://mobbin.com/flows/833ab9dc-b0a4-4145-99f0-5249b85ae35d) | Keep search, selection, confirmation and the updated collection connected. |
| [Spotify queue flow](https://mobbin.com/flows/5a4e7313-447f-419b-bf5a-27b26bf6d7e9) | Keep playback controls available during queue management. |
| [Shopify option selection](https://mobbin.com/flows/a3d897d9-eada-4044-b9f5-1368ed8741df) | Explicit edition selection before committing an action. |
| [lululemon order tracking](https://mobbin.com/flows/8d83fa1d-856c-40d1-acbf-689c5e5c3abb) | Group requests by meaningful state, with a visible journey and next action. |

Three visual directions were explored: warm record shop, midnight/lime listening app, and white typographic gallery. Warm record shop was selected because it gives Leerr its own identity and lets diverse artwork remain the primary colour.

## Information architecture and responsive behaviour

- **Discover:** recommendations with one featured record; recently added music; new releases when provided by the integration; artist/album search; edition selection and request confirmation.
- **Library:** one collection heading, album/artist/playlist tabs, title filtering, sort and favourites. Recently added moved to Discover rather than duplicating the main grid.
- **Requests:** a three-step explanation and All / In progress / Ready / Needs attention views. Unmatched Plex albums belong in Needs attention even if already imported.
- **Settings:** retain connection, account, household and administrative functionality under the shared visual system.
- **Listening:** preserve album/track actions, the persistent player once playback starts, and the queue. Desktop uses a fixed sidebar; narrow layouts use bottom navigation, stacked content and a player that leaves room for its controls.

The preview uses fictional records, local sample artwork and fake upstreams. It cannot save real credentials and is not a deployment target.
