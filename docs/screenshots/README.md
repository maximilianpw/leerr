# README screenshots

These images show a running self-hosted Leerr installation connected to a real
Plex music library. They were captured from its signed-in desktop browser on
October 9, 2026. Album artwork, metadata, suggestions and request statuses come
from the application. No product content was fabricated or composited.

| File | View | Image size |
| --- | --- | --- |
| `library.png` | Library sorted by Recently added | 1600 × 991 |
| `album.png` | Human After All by Daft Punk, with track formats and durations | 1600 × 991 |
| `discover.png` | New from your artists and Last.fm suggestions | 1600 × 991 |
| `request-edition.png` | Homework edition picker | 1094 × 1400 |
| `requests.png` | Existing failed requests with explanations and retry controls | 1600 × 991 |

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

The original window captures were 3024 × 1898 pixels. Landscape images use a
2614 × 1620 crop starting at x=402, y=70. The edition image uses a 1360 × 1740
crop starting at x=1030, y=100. Adjust these bounds for a different window size.

The captures did not submit or retry requests, start playback, change favourites
or playlists, or change server settings. The failed requests are existing state
and appear in the README as a troubleshooting example.

For documentation work without a live installation, `npm run preview` provides
a separate demo with sample data. Label demo captures explicitly if using them.
