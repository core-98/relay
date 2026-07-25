# Relay

Relay is an installable, privacy-first PWA for sharing a local video directly
with up to five other devices. It uses WebRTC for media, an AES-GCM encrypted
data channel for room controls, and an ephemeral signalling endpoint for peer
discovery. Nothing is uploaded and nothing is stored.

## What works

- Host-created rooms with a six-digit code, rendered three ways: digits, a
  three-word phrase, or an invite link with a QR code
- A separate 256-bit invite key kept in the URL fragment
- Direct WebRTC media from the host device; the video file is never uploaded
- MP4, MKV, WebM, MOV, Ogg, and MPEG-TS input. Files the browser cannot open
  directly are normalized to H.264/AAC MP4 on the host device, backed by
  temporary browser-private storage rather than a server upload
- Canvas-backed video capture, so a browser decode path that exposes only an
  MP4 audio track cannot silently produce an audio-only stream for viewers
- Synchronised playback ("sync locked to me") and per-viewer independent
  streams ("free seek allowed")
- Exclusive playback control: the host hands it to one viewer at a time, and
  viewers can request it
- Per-viewer mute — enforced by dropping the audio track from that one sender,
  not by asking the viewer's client nicely
- Removing a viewer, which revokes their signalling seat as well as their stream
- Rotating the invite mid-session: a new room and key are issued, everyone
  currently connected migrates across, and the old invite stops admitting anyone
- A 240p–1080p quality ladder on top of WebRTC's own adaptation, set by the host
  globally or by each viewer for their own downlink
- Live transport readouts (bitrate, round trip, packet loss, delivered
  resolution) taken from `RTCPeerConnection.getStats()`
- A 60-second reconnect window when the host's connection drops, after which the
  session and its keys are gone
- Installable PWA shell with no accounts, database, or persisted room history

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. For a real cross-device test, serve the app over
HTTPS; browser media and cryptography APIs are secure-context features.

```bash
npm run build
npm test
```

## Codes and keys

The six-digit code and the word phrase are two renderings of the same room id —
a base-100 encoding of one another, so `472913` and `larch-crystal-cedar` address
the same room. They are **not** key material: six digits cannot carry a 256-bit
key. The invite key is generated in the host's tab and travels only in the URL
fragment of the invite link, which browsers never send to a server.

That is why the join screen asks for the key separately when someone types a
bare code, and why the share panel marks the link as the format that carries it.
Making a short code stand in for the key would need a PAKE (the Magic Wormhole
approach), which this prototype does not implement.

## Privacy model

The signalling endpoint receives only the room code, temporary peer IDs, display
names, and WebRTC negotiation messages. It never receives the invite key or video
content. Room metadata is held only in process memory and expires.

WebRTC encrypts media in transit using DTLS-SRTP. Control messages — permission
grants, playback commands, mutes, invite rotations — receive an additional
AES-256-GCM layer using the invite key, so the signalling service can neither
read nor forge them.

## Design system

The interface is built on the Modernist design system imported from Claude
Design: `app/globals.css` carries its tokens and component classes, retuned for
Relay's dark surface. Typography is Archivo; radii are 0 throughout.

## Before public deployment

This prototype uses an in-memory signalling map and public STUN. A production
deployment should move the same ephemeral room protocol to a single transient
coordination service (for example, a Cloudflare Durable Object with no storage)
and add a TURN service for peers that cannot connect directly. TURN must relay
WebRTC packets in memory and must not log room or content data.

Independent mode creates one local playback pipeline per viewer, so the agreed
five-viewer limit is intentional. Container conversion can only handle codecs
the host browser can decode locally; unsupported codecs are rejected with a
specific error before a room is created.
