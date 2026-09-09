# Real-device lossless acceptance gate

**Status: NOT RUN. This document is a procedure and blank report, not evidence
that playback, original delivery, or hardware output has been verified.**

Stage 5 of the implementation work accepts the lossless vertical slice, not
Lidarr/discovery or the entire first-version product. Follow the contracts in
[architecture](architecture.md#playback-is-the-first-integration-gate) and the
[native testing prerequisites](development.md#prerequisite-for-amp-driven-native-ui-testing).
The architecture's numbered implementation roadmap is a separate sequence.

Updated preflight, 9 September 2026: the Mac runner is connected and native
build/disconnected UI checks passed, as recorded in the
[native verification report](native-verification-2026-09-09.md). The paired
physical iPhone is unavailable and no authorized live service credentials or
delivery-capture setup were supplied. Real-device audio and live delivery
evidence are blocked. Neither core tests nor a Simulator pass can clear this gate.
This procedure does not authorize provisioning infrastructure, importing files
into someone else's library, or changing shared server/transcode settings.
Use an existing authorized test server/account; obtain permission for writes.

## Run the gate with Jellyfin instead of Navidrome

Navidrome is not a prerequisite. Select Jellyfin in Connect and use an authorized
Jellyfin user with a scanned Music library and audio playback permission. Record
the Jellyfin version, reverse-proxy base path (without credentials), fixture item
ID, source metadata and server policy. Wherever this procedure names Navidrome,
use the selected server and its corresponding metadata/capture evidence.

For Jellyfin, correlate the app's `/Audio/{id}/stream` request with `static=true`
and validate HTTP 206 / Content-Range behavior through the real proxy. Its
`ApiKey` query parameter is a secret: redact it from logs and never copy the
authenticated URL into evidence. There should be no media redirect or encoding
parameters. Still compare delivered bytes and PCM with the independent fixture;
static intent alone does not pass lossless acceptance. Album ProviderIds
`MusicBrainzAlbum` and `MusicBrainzReleaseGroup` identify the release and group,
respectively. For request acceptance, wait for Jellyfin indexing rather than
mistaking Lidarr import for availability. Do not trigger scans or alter server
settings without authorization.

## What counts as evidence

Keep these three categories separate in the UI and the report:

| Category | Acceptable evidence | Does not establish |
| --- | --- | --- |
| Source | Independently measured local fixture format and hashes, then indexed library metadata compared against them | Bytes actually delivered to the app |
| Delivered | Correlated playback request/server response evidence, actual media format observations, and validated response bytes | Hardware/DAC output format or bit-perfect output |
| Hardware output | Named physical route/device and, if measured separately, output observations | Original delivery merely because a DAC advertises a high sample rate |

An original-stream request, a `.flac` suffix, MIME type, bitrate estimate, or
library `codec` field alone is not delivery verification. An AVFoundation PCM
decode format alone does not prove the incoming compressed codec or lack of
transcoding. Unknown codec/rate/depth/transcode state must remain **unknown**;
never substitute source metadata into a delivered label. A lossless-to-lossless
transcode is still a transcode. A matching PCM hash proves sample equivalence,
not byte-identical original-file delivery. Bluetooth, system mixing and sample
rate conversion may affect output independently; bit-perfect/exclusive playback
and automatic output-rate switching are outside this gate.

## Prepare a legal fixture with independent expectations

Use a developer-owned or licensed FLAC with recorded provenance, or generate the
synthetic signal below. This optional recipe needs Python 3, ffmpeg and ffprobe;
do not install them as part of the gate. It writes only to a fresh temporary
directory, does not contact a server and uses no copyrighted recording.

The independent source is exactly 2,880,000 stereo frames at 48,000 Hz, signed
24-bit PCM, for 60 seconds. Left and right use different low-amplitude integer
ramps, so swapped, downmixed or truncated channels differ. Start listening at
low volume. The generator hashes its PCM directly, before any FLAC encoder or
decoder is involved; no expectation is copied from app/server metadata.

```sh
set -eu
FIXTURE_DIR=$(mktemp -d)
export FIXTURE_DIR
python3 - <<'PY'
import hashlib, json, os, wave
from pathlib import Path
p = Path(os.environ["FIXTURE_DIR"])
frames = 48_000 * 60
pcm = bytearray()
for i in range(frames):
    left = ((i % 240) - 120) * 1021
    right = ((i % 400) - 200) * 509
    pcm.extend(left.to_bytes(3, "little", signed=True))
    pcm.extend(right.to_bytes(3, "little", signed=True))
with wave.open(str(p / "source.wav"), "wb") as wav:
    wav.setnchannels(2)
    wav.setsampwidth(3)
    wav.setframerate(48_000)
    wav.writeframes(pcm)
expected = {
    "provenance": "Synthetic integer ramps generated by this procedure",
    "codec": "flac", "sample_rate_hz": 48_000, "bits_per_sample": 24,
    "channels": 2, "frames": frames, "duration_seconds": 60,
    "pcm_encoding": "signed 24-bit little-endian, interleaved L/R",
    "pcm_bytes": len(pcm), "pcm_sha256": hashlib.sha256(pcm).hexdigest()
}
(p / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
PY
ffmpeg -v error -i "$FIXTURE_DIR/source.wav" -map 0:a:0 \
  -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 \
  -metadata title="Leerr Synthetic 48k 24bit" \
  -metadata artist="Leerr Test Signal" -metadata album="Lossless Acceptance" \
  "$FIXTURE_DIR/original.flac"
ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels,bits_per_raw_sample,duration \
  -of json "$FIXTURE_DIR/original.flac"
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ["FIXTURE_DIR"])
manifest = json.loads((p / "expected.json").read_text())
manifest["original_file_sha256"] = hashlib.sha256((p / "original.flac").read_bytes()).hexdigest()
(p / "expected.json").write_text(json.dumps(manifest, indent=2) + "\n")
print((p / "expected.json").read_text())
PY
```

Confirm ffprobe reports FLAC, 48000 Hz, 2 channels and 24 raw bits (not the
32-bit decoder storage width). Record Python/ffmpeg/ffprobe versions and keep
the manifest immutable **before upload**. Container hash may vary across
encoder versions; the PCM expectation does not. Decode the original using the
comparison recipe below with `DELIVERED_FILE="$FIXTURE_DIR/original.flac"` to
validate the encoder round trip first. Failure stops fixture preparation.

Import only with authorization; record completion of the server's scan and the
test-only track ID. For queue tests add a second distinguishable legal track,
recording its own manifest/metadata. Do not pretend two queue entries prove
track transition if they cannot be distinguished audibly and in Now Playing.

## Server and delivery evidence

Before playback record the Navidrome version/build, reverse proxy version and
path shape (redacted host), account/player/client identifier, and effective
server, account, player and proxy transcode/bitrate policies. Record policy
precedence, not just a global screenshot saying transcoding is off. Never
change a production setting to manufacture a pass.

For each platform and network path, correlate a test timestamp and non-secret
request ID with:

1. The app's actual stream operation and original-format parameters. Record
   the sanitized endpoint path and non-secret format/bitrate parameters (for
   example `format=raw` if supported by this server version). Check those
   parameters against the deployed server's documentation/implementation and
   retain its versioned reference. Do not assume a parameter guarantees that
   server policy honors it.
2. Effective policy at request time and a server-side decision showing original
   delivery/no transcoder invocation. If the server cannot expose that fact,
   record it as unknown and use response-byte identity as independent evidence;
   do not fabricate an explicit server decision.
3. Final response status, sanitized MIME type, length/range headers, redirect
   hops (scheme/host aliases/port only), and actual delivered codec/rate/depth
   observations with their provenance. Ensure caches did not substitute an
   unrelated response; record the test cache state.
4. The complete response entity bytes from that same playback path, obtained
   with approved instrumentation. If the player issues ranges, validate full
   contiguous coverage and entity identity before reconstructing; hashing one
   range or concatenating overlapping ranges is not a full-file comparison.
   Do not bypass TLS verification or proxy production credentials to capture it.

A separate download with the same account/parameters is useful corroboration,
but is not proof of what AVPlayer received. If capture cannot be tied to the
actual app request and effective policy, original delivery remains unverified
and the gate is blocked. MIME and app/library claims cannot fill that gap.

Store an approved complete response as a local file, then use this comparison
in the same shell as fixture preparation. Do not paste authenticated URLs into
commands, shell history, reports or bug trackers. Use ffprobe on the response
as above as well as checking bytes:

```sh
set -eu
# Set to a local response file; no URL or credentials.
DELIVERED_FILE="$FIXTURE_DIR/delivered.flac"
export DELIVERED_FILE
ffmpeg -v error -i "$DELIVERED_FILE" -map 0:a:0 \
  -c:a pcm_s24le -f s24le -y "$FIXTURE_DIR/delivered.pcm"
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
p = Path(os.environ["FIXTURE_DIR"])
expected = json.loads((p / "expected.json").read_text())
pcm = (p / "delivered.pcm").read_bytes()
original = hashlib.sha256(Path(os.environ["DELIVERED_FILE"]).read_bytes()).hexdigest() == expected["original_file_sha256"]
samples = len(pcm) == expected["pcm_bytes"] and hashlib.sha256(pcm).hexdigest() == expected["pcm_sha256"]
print(f"original_file_match={original}; pcm_match={samples}")
if not (original and samples):
    raise SystemExit("FAIL: original-delivery fixture comparison")
PY
```

Both matches must be true for this original-file gate. PCM match with a file
mismatch may mean retagging/remuxing/transcoding; investigate and record it,
but do not call it byte-identical original delivery. Do not add `-ar` or `-ac`
to the decode command: resampling/downmixing would conceal a format mismatch.
Run each command successfully before using its output; a failed decode must
not be followed by comparison of a stale PCM file.

## Real-device checklist

Record a physical iPhone model, exact iOS version/build, and a physical Mac
model/chip and exact macOS version/build. Record Xcode/Swift versions, signing
mode, tested commit and local diff, test date/operator, output route/DAC/headset,
volume, and Audio MIDI Setup rate on Mac (an output setting, not delivery proof).
Use the same tested revision on both platforms. Record local-network permission
state, background-audio capability and any required OS/media permissions.

Record each network topology: Wi-Fi band/router alias, server LAN or remote,
VPN/proxy/TLS path, measured available bandwidth and latency, and iPhone
cellular policy where available. Use valid HTTPS with normal certificate trust.
A private IP/VPN does not authorize cleartext or a trust bypass. Wi-Fi on each
device is required; if cellular is unavailable mark it BLOCKED rather than
claiming a Wi-Fi-to-cellular handover pass.

Run the following on **both devices**, except where explicitly platform-specific.
Use at least two distinct fixture tracks in the queue. Attach timestamped,
redacted logs and inspected native screenshots for quality/error/Now Playing
states; record short clips only where timing or continuity matters.

| Test | Procedure and pass criterion |
| --- | --- |
| Connect and find | Valid test account connects over HTTPS; browse and search find the scanned fixture; opening its album shows the expected tracks. Invalid credentials and unreachable server yield recoverable errors without secrets. |
| Original FLAC | Play the remote fixture from start through end. Complete all delivery evidence and comparisons above on both platforms. Audible playback and progression are required, not merely a ready player item. |
| Format truth | Source values match manifest. Delivered values have identified observations, not copied source values. Exercise missing format/transcode observations and a controlled known transcode where authorized: unknown remains unknown, observed differences are labeled accurately, and no lossy/unknown stream receives a verified-lossless badge. An inability to create these states leaves this test BLOCKED. |
| Transport/queue | Pause for 5 seconds and resume; seek to 10 then 45 seconds (settles within 2 seconds of target); next/previous switches distinct tracks and metadata; natural end advances exactly once. Queue order and elapsed time remain consistent in app and system UI. |
| iPhone lock screen | Lock for 2 minutes with enough queued audio. Playback continues and advances tracks; lock-screen play/pause/next/previous and seek, where exposed, act once, with correct title, duration and elapsed time. Unlock preserves queue/state. |
| iPhone background | Switch to another app for 2 minutes, then return. Playback/queue continue without unexpected suspension or duplicate command handlers. Backgrounding is not force-quitting; force-quit continuation is not required. |
| iPhone interruption | During playback trigger a real call or Siri interruption; audio pauses/ducks appropriately with truthful state. After interruption, resume only when platform policy allows; manual resume always recovers. Repeat while already paused: no unsolicited playback. Record which interruption was used. |
| Route changes | Disconnect headphones while playing: no unexpected loudspeaker playback. Connect a route and resume deliberately; no doubled audio or stale route/state. Repeat while paused; remain paused. Record wired/Bluetooth route explicitly without making output-quality claims. |
| Mac system controls | While app is unfocused, use media keys and Control Center/Now Playing play/pause/next/previous. Each command acts once; metadata/progression match the active track. If multiple windows are supported, they share one player/queue without duplicate audio. |
| Network loss | Disconnect Wi-Fi/network until buffered audio drains; record time and buffering behavior. No false progressing/playing claim after playback stalls, no crash or secret-bearing error. Restore network: a clear retry or automatic recovery resumes within 30 seconds of retry/reconnection on an otherwise healthy path, preserving queue and usable seek controls. Record observed recovery policy. |
| Network handover | On iPhone, switch Wi-Fi to cellular and back with test authorization. Report original/bandwidth policy and actual format for each path, including revalidation after recovery; no stale verified label from the preceding item/path. On Mac test the available alternate authorized interface or explicitly record unavailable coverage. |
| Account/disconnect | Disconnect/change account during playback and reconnect. Old audio stops, old queue/quality metadata clears, and a stale request cannot restart playback under the new identity. |

For two-minute cases queue/repeat sufficient audio and record the arrangement;
do not mistake the fixture's natural end at 60 seconds for an interruption.
Sleep/wake on Mac is a separate observation: do not demand playback while the
machine sleeps; after wake, state must be accurate and manual recovery usable.

## Redirect and credential security gate

Use only authorized controlled redirect endpoints with disposable test
credentials and valid TLS. Do not send real tokens to a third-party collector.
Test redirects in both API requests and the **actual media loader** (AVPlayer
may not share URLSession's redirect delegate). Unit redirect tests alone are
insufficient. For every redirect hop test:

- Same-origin HTTPS, including a reverse-proxy subpath: any supported redirect
  completes under policy, preserves the intended resource, and avoids loops.
  Safe rejection is acceptable if reported as unsupported, not as playback.
- Different host, scheme or port; HTTPS to HTTP; and a same-origin first hop
  followed by a cross-origin hop: reject before forwarding authentication.
  For prohibited hops the controlled target must observe no authenticated
  request, including query tokens, Authorization/Cookie headers or Referer leaks.
- Redirect loops and invalid/untrusted TLS certificates fail safely with a
  recoverable sanitized message, no certificate bypass and no retry storm.

Inspect app/system diagnostics, UI errors and saved evidence for raw authenticated
URLs, salts/tokens/passwords, cookies and response bodies. Save only redacted
copies with test aliases. A credential leak or prohibited authenticated redirect
is an immediate FAIL, even if audio sounds correct. Missing endpoint visibility
or unsafe test setup means BLOCKED, not PASS. Delete sensitive temporary capture
material according to the operator's retention policy; never commit it.

## Fill-in acceptance report — NOT RUN

Copy this section into a dated report only after execution. Keep unexecuted rows
as NOT RUN; never prefill PASS from unit tests or this procedure.

- Overall: **NOT RUN**
- Operator/date/timezone: NOT RUN
- Tested revision/local diff; native build/launch evidence: NOT RUN
- Physical iPhone/iOS; Mac/macOS; toolchains/signing: NOT RUN
- Audio routes/output settings (no bit-perfect claim): NOT RUN
- Networks/bandwidth/latency/TLS/proxy/permissions: NOT RUN
- Fixture provenance, immutable manifest and encoder versions: NOT RUN
- Server version/versioned parameter reference/effective transcode policy: NOT RUN
- Per-platform request correlation, response/range evidence and byte hashes: NOT RUN
- Redacted evidence locations, inspected screenshots and issue references: NOT RUN

| Required result | iPhone | Mac | Evidence / failure / blocker |
| --- | --- | --- | --- |
| Secure connect, browse/search, recoverable errors | NOT RUN | NOT RUN | — |
| Original delivery and complete-file + PCM matches | NOT RUN | NOT RUN | — |
| Delivered/source/unknown and controlled transcode truth | NOT RUN | NOT RUN | — |
| Queue, seek, natural end and transport | NOT RUN | NOT RUN | — |
| System controls and truthful Now Playing | NOT RUN | NOT RUN | — |
| Background/lock screen/interruption | NOT RUN | N/A (iOS-specific) | — |
| Route change and paused-state safety | NOT RUN | NOT RUN | — |
| Network loss/recovery and handover coverage | NOT RUN | NOT RUN | — |
| Disconnect/account isolation | NOT RUN | NOT RUN | — |
| API + media redirect security/TLS/redacted errors | NOT RUN | NOT RUN | — |

**PASS:** every required case passed on both physical platforms with attached
evidence, original bytes and expected format verified on the accepted original
path, and no unknown delivered fact presented as verified. Report the exact
network/output scope, including any unavailable alternate interfaces. Optional
handover coverage may remain unavailable only with an explicit limitation; it
does not permit a handover or mobile-data lossless claim. N/A is otherwise only
for explicitly platform-specific cases, not a way to waive a failed feature.

**FAIL:** an executed required criterion is violated, including lossy delivery
on the requested original path, misleading quality reporting, leaked
credentials, unsafe redirects or broken required playback/system controls.
Retain evidence and link the defect; retest the affected cases after fixing it.

**BLOCKED / NOT RUN:** hardware, live authorized server/account, instrumentation,
implemented feature, or required evidence is missing. Unknown delivery cannot
pass the original-delivery gate even when the UI correctly says unknown.
Only an executed real-device report can change this gate to PASS; fixture
generation, package tests, native builds and Simulator runs cannot do so.
