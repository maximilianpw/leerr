# README screenshots

These images show a running self-hosted Leerr installation connected to a real
Plex music library. They were captured from its signed-in desktop browser on
October 29, 2026, except `request-edition.png`, which dates from October 9, 2026
and predates the current design. Album artwork, metadata, suggestions and
request statuses come from the application. No product content was fabricated
or composited.

| File | View | Image size |
| --- | --- | --- |
| `library.png` | Library sorted by Recently added | 1600 × 973 |
| `album.png` | Human After All by Daft Punk, with track formats and durations | 1600 × 1017 |
| `discover.png` | Featured Last.fm suggestion and further suggestions | 1600 × 917 |
| `request-edition.png` | Homework edition picker | 1094 × 1400 |
| `requests.png` | Requests in the library, downloading and needing attention | 1600 × 1046 |

## Refresh the images

1. Open an authorized, signed-in installation with a populated Plex library.
2. Visit Library, an album, Discover and Requests. To capture the edition picker,
   open an album available to request without submitting a request.
3. Wait for artwork, fonts and suggestions to finish loading, then capture the
   browser window. Keep the application's content and styling intact.
4. Crop out browser chrome and the account area. Keep credentials, private host
   addresses and unrelated tabs out of the images. Crop the edition image around
   the dialog; its background blur comes from the app.
5. Export as PNG. Resize landscape views to 1600 pixels wide and the edition
   dialog to 1400 pixels tall. Check the resulting images and their README
   captions together.

The window captures were 3024 × 1898 pixels. Library, album and Requests use a
2578-pixel-wide crop starting at x=402, y=70, ending above the account area and
any partly visible row: 1568, 1638 and 1686 pixels tall respectively. Requests
was scrolled down by one wheel step first. The edition image uses a
1360 × 1740 crop starting at x=1030, y=100. Adjust these bounds for a different
window size.

`discover.png` was captured at 3406 × 2416 pixels and uses a 3390 × 1942 crop
starting at x=0, y=0. The crop ends above the Recently added row and the account
area.

The captures did not submit or retry requests, start playback, change favourites
or playlists, or change server settings. Library's sort and favourites filter
were changed only as view settings. The request statuses are existing state; the
request needing attention appears in the README as a troubleshooting example.

For documentation work without a live installation, `npm run preview` provides
a separate demo with sample data. Label demo captures explicitly if using them.
