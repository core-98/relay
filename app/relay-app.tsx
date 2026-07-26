"use client";

import {
  CSSProperties,
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** The address bar never changes under us without a full navigation. */
const subscribeNothing = () => () => {};

import {
  AlertIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  CloseIcon,
  ControlIcon,
  CopyIcon,
  ExpandIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  VolumeIcon,
  VolumeOffIcon,
} from "./icons";
import {
  CodeFormat,
  formatRoomCode,
  inviteUrl,
  makeRoomCode,
  makeSecret,
  parseInvite,
  renderCode,
} from "./lib/session-code";
import {
  FULL_CONTROL,
  NO_PERMISSIONS,
  PlaybackAction,
  PlaybackMode,
  Permissions,
  Quality,
  SecureMessage,
  SubtitleCue,
  decryptMessage,
  encryptMessage,
  importRoomKey,
} from "./lib/secure-channel";
import { qrPath } from "./lib/qr";
import {
  EMPTY_SAMPLE,
  TransportSample,
  formatRate,
  rungForHeight,
  sampleTransport,
} from "./lib/peer-stats";
import { VIDEO_FILE_ACCEPT, preparePlayableVideo } from "./lib/playable-media";

type Screen = "landing" | "host" | "join" | "room";
type Panel = "people" | "share" | "trust";
type Participant = { id: string; name: string; role: "host" | "viewer" };
type RoomSession = {
  code: string;
  secret: string;
  peerId: string;
  hostId: string;
  isHost: boolean;
};
type PeerState = {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  name: string;
  muted: boolean;
  personalVideo?: HTMLVideoElement;
  audioTrack?: MediaStreamTrack;
  playbackRate: number;
  sample: TransportSample;
};
type PeerReadout = { kbps: number; rtt: number; height: number; loss: number };
type AudioMixerState = {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
};

const QUALITY_LADDER: { id: Quality; label: string; note: string }[] = [
  { id: "auto", label: "Auto", note: "adaptive" },
  { id: "1080", label: "1080p", note: "5.0 Mbps" },
  { id: "720", label: "720p", note: "2.6 Mbps" },
  { id: "480", label: "480p", note: "1.1 Mbps" },
  { id: "240", label: "240p", note: "480 kbps" },
];

const QUALITY_SETTINGS: Record<
  Quality,
  { scaleResolutionDownBy?: number; maxBitrate?: number }
> = {
  auto: {},
  "1080": { scaleResolutionDownBy: 1, maxBitrate: 5_000_000 },
  "720": { scaleResolutionDownBy: 1.5, maxBitrate: 2_600_000 },
  "480": { scaleResolutionDownBy: 2.25, maxBitrate: 1_100_000 },
  "240": { scaleResolutionDownBy: 4.5, maxBitrate: 480_000 },
};

const CODE_TABS: { id: CodeFormat; label: string }[] = [
  { id: "numeric", label: "6-digit" },
  { id: "words", label: "Words" },
  { id: "link", label: "Link + QR" },
];

const PANEL_TABS: { id: Panel; label: string }[] = [
  { id: "people", label: "People" },
  { id: "share", label: "Share" },
  { id: "trust", label: "Privacy" },
];

/** Each step is a real await in the host setup, not a timed animation. */
const PREP_STEPS = [
  "Reading the file locally",
  "Generating the session key",
  "Registering the room",
  "Ready to share",
];

const TRUST_ROWS: [string, string][] = [
  ["Video path", "host device → viewer"],
  ["Server role", "signalling only"],
  ["Server load", "none · no upload"],
  ["Media transport", "WebRTC · DTLS-SRTP"],
  ["Control channel", "AES-256-GCM"],
  ["Invite key", "URL fragment, never sent"],
  ["Session log", "not written"],
  ["Retention", "0 s after last peer"],
];

const RECONNECT_WINDOW = 60;
const WEAK_KBPS = 900;
const WEAK_LOSS = 4;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const SUBTITLE_CHUNK_SIZE = 80;
const FULLSCREEN_CONTROLS_DELAY = 2400;

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  const pad = (input: number) => String(input).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${Math.round(bytes / 1000)} kB`;
}

function parseSubtitleTime(input: string) {
  const parts = input.trim().replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number.NaN;
}

function parseSubtitleFile(source: string) {
  const blocks = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endWithSettings] = lines[timingIndex].split("-->");
    const endText = endWithSettings?.trim().split(/\s+/)[0] ?? "";
    const start = parseSubtitleTime(startText);
    const end = parseSubtitleTime(endText);
    const text = lines
      .slice(timingIndex + 1)
      .join("\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
      cues.push({ start, end, text });
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  const letters = parts.slice(0, 2).map((part) => part[0]);
  return (letters.length === 1 ? parts[0].slice(0, 2) : letters.join("")).toUpperCase();
}

function moveVideoTo(video: HTMLVideoElement, seconds: number) {
  if (typeof video.fastSeek === "function") video.fastSeek(seconds);
  else video.currentTime = seconds;
}

/** Six digits collide rarely, but a taken code should not end the setup. */
async function claimRoom(peerId: string, displayName: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeRoomCode();
    try {
      await signalRequest({ action: "create", room: code, peerId, name: displayName });
      return code;
    } catch (claimError) {
      const taken = claimError instanceof Error && /already active/.test(claimError.message);
      if (!taken) throw claimError;
    }
  }
  throw new Error("Could not reserve a room code — try again");
}

async function signalRequest(
  body: Record<string, unknown>,
  options: { allowNotFound?: boolean } = {},
) {
  const response = await fetch("/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok && !(options.allowNotFound && response.status === 404)) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Could not reach the room");
  }
  return response.ok ? response.json() : null;
}

export function RelayApp() {
  // The address bar is external state: the server renders the landing screen
  // and the client swaps to the prefilled join screen once it can read it.
  const location = useSyncExternalStore(
    subscribeNothing,
    () => window.location.search + window.location.hash,
    () => "",
  );
  const origin = useSyncExternalStore(
    subscribeNothing,
    () => window.location.origin,
    () => "",
  );
  const urlInvite = useMemo(() => parseInvite(location), [location]);

  const [screenOverride, setScreenOverride] = useState<Screen | null>(null);
  const screen = screenOverride ?? (urlInvite.code ? "join" : "landing");
  const setScreen = setScreenOverride;

  const [session, setSession] = useState<RoomSession | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [privacyOpen, setPrivacyOpen] = useState(false);

  // Host setup
  const [codeDraft, setCodeDraft] = useState<{ code: string; secret: string } | null>(null);
  const [prep, setPrep] = useState(-1);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [conversionProgress, setConversionProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [codeFormat, setCodeFormat] = useState<CodeFormat>("numeric");

  // Join — each field falls back to whatever the invite link carried.
  const [joinDraft, setJoinDraft] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [keyPrompt, setKeyPrompt] = useState<boolean | null>(null);
  const joinInput =
    joinDraft ??
    (urlInvite.code
      ? urlInvite.secret
        ? inviteUrl(origin, urlInvite.code, urlInvite.secret)
        : urlInvite.code
      : "");
  const needsKey = keyPrompt ?? Boolean(urlInvite.code && !urlInvite.secret);

  // Room
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [panel, setPanel] = useState<Panel>("people");
  const [mode, setMode] = useState<PlaybackMode>("sync");
  const [quality, setQuality] = useState<Quality>("auto");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [subtitleName, setSubtitleName] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitlesOn, setSubtitlesOn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [videoAspect, setVideoAspect] = useState(16 / 9);
  const [myPermissions, setMyPermissions] = useState<Permissions>(NO_PERMISSIONS);
  const [controlHolder, setControlHolder] = useState<string | null>(null);
  const [holderName, setHolderName] = useState("");
  const [pendingControl, setPendingControl] = useState<Participant | null>(null);
  const [pleaSent, setPleaSent] = useState(false);
  const [mutedPeers, setMutedPeers] = useState<string[]>([]);
  const [peerReadouts, setPeerReadouts] = useState<Record<string, PeerReadout>>({});
  const [ownSample, setOwnSample] = useState<TransportSample>(EMPTY_SAMPLE);
  const [selfMuted, setSelfMuted] = useState(false);
  // A remote stream carries audio, so it can only autoplay muted. The picture
  // starts immediately either way and sound is one click behind it.
  const [soundOn, setSoundOn] = useState(false);
  const [volume, setVolume] = useState(1);
  const [userMuted, setUserMuted] = useState(false);
  const [pictureReady, setPictureReady] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [disconnectedFor, setDisconnectedFor] = useState<number | null>(null);
  const [countdown, setCountdown] = useState(RECONNECT_WINDOW);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [mobileFullscreen, setMobileFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const isFullscreen = nativeFullscreen || mobileFullscreen;

  const sessionRef = useRef<RoomSession | null>(null);
  const modeRef = useRef<PlaybackMode>("sync");
  const keyRef = useRef<CryptoKey | null>(null);
  const peersRef = useRef(new Map<string, PeerState>());
  const pendingIceRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const permissionsRef = useRef<Record<string, Permissions>>({});
  const holderRef = useRef<string | null>(null);
  const holderNameRef = useRef("");
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  // Muted autoplay is the only kind a browser grants, so the element's audio
  // state has to be applied before play() rather than on the next render.
  const audioRef = useRef({ volume: 1, muted: true });
  const stageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef("");
  const mediaFileRef = useRef<File | null>(null);
  const mediaCleanupRef = useRef<() => Promise<void>>(async () => undefined);
  const capturePipelinesRef = useRef(
    new Map<HTMLVideoElement, { stream: MediaStream; stop: () => void }>(),
  );
  const audioMixersRef = useRef(new Map<HTMLVideoElement, AudioMixerState>());
  const pollBusyRef = useRef(false);
  const migratingRef = useRef(false);
  const teardownRef = useRef(false);
  const subtitleRef = useRef<{ name: string; cues: SubtitleCue[]; enabled: boolean }>({
    name: "",
    cues: [],
    enabled: false,
  });
  const fullscreenControlsTimerRef = useRef<number | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    holderRef.current = controlHolder;
  }, [controlHolder]);
  useEffect(() => {
    holderNameRef.current = holderName;
  }, [holderName]);
  useEffect(() => {
    subtitleRef.current = { name: subtitleName, cues: subtitleCues, enabled: subtitlesOn };
  }, [subtitleCues, subtitleName, subtitlesOn]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((message: string) => setToast(message), []);

  const rememberVideoAspect = useCallback((video: HTMLVideoElement) => {
    if (!video.videoWidth || !video.videoHeight) return;
    setVideoAspect(Math.min(2.4, Math.max(0.5, video.videoWidth / video.videoHeight)));
  }, []);

  const attachRemoteStream = useCallback(() => {
    const video = remoteVideoRef.current;
    const stream = remoteStreamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.volume = audioRef.current.volume;
    video.muted = audioRef.current.muted;
    // Muted playback is always permitted; if even that is refused the stage
    // offers the tap.
    video.play().then(
      () => setNeedsGesture(false),
      () => setNeedsGesture(true),
    );
  }, []);

  /* ─── secure channel ──────────────────────────────────────────────── */

  const sendSignal = useCallback(async (to: string, data: unknown) => {
    const current = sessionRef.current;
    if (!current) return;
    await signalRequest(
      { action: "signal", room: current.code, peerId: current.peerId, to, data },
      { allowNotFound: true },
    ).catch(() => undefined);
  }, []);

  const sendSecure = useCallback(async (peerId: string, message: SecureMessage) => {
    const peer = peersRef.current.get(peerId);
    const key = keyRef.current;
    if (!peer?.channel || peer.channel.readyState !== "open" || !key) return;
    peer.channel.send(await encryptMessage(key, message));
  }, []);

  const broadcastSecure = useCallback(
    async (message: SecureMessage) => {
      await Promise.all([...peersRef.current.keys()].map((id) => sendSecure(id, message)));
    },
    [sendSecure],
  );

  const sendSubtitleTrack = useCallback(
    async (
      peerId: string,
      track = subtitleRef.current,
    ) => {
      if (!track.cues.length) {
        await sendSecure(peerId, {
          type: "subtitles",
          name: "",
          cues: [],
          offset: 0,
          complete: true,
        });
        return;
      }
      for (let offset = 0; offset < track.cues.length; offset += SUBTITLE_CHUNK_SIZE) {
        const cues = track.cues.slice(offset, offset + SUBTITLE_CHUNK_SIZE);
        await sendSecure(peerId, {
          type: "subtitles",
          name: track.name,
          cues,
          offset,
          complete: offset + cues.length >= track.cues.length,
        });
      }
      await sendSecure(peerId, { type: "subtitles-toggle", enabled: track.enabled });
    },
    [sendSecure],
  );

  /* ─── media plumbing ──────────────────────────────────────────────── */

  const setPeerQuality = useCallback(async (peerId: string, next: Quality) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    const settings = QUALITY_SETTINGS[next];
    const senders = peer.pc.getSenders().filter((sender) => sender.track?.kind === "video");
    await Promise.all(
      senders.map(async (sender) => {
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
        parameters.encodings[0].scaleResolutionDownBy = settings.scaleResolutionDownBy;
        parameters.encodings[0].maxBitrate = settings.maxBitrate;
        await sender.setParameters(parameters).catch(() => undefined);
      }),
    );
  }, []);

  const ensureAudioMixer = useCallback((video: HTMLVideoElement) => {
    const existing = audioMixersRef.current.get(video);
    if (existing) return existing;

    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return null;

    const context = new AudioContextClass({ latencyHint: "playback" });
    try {
      const source = context.createMediaElementSource(video);
      // Only the visible host video should also play through the local speakers.
      // Hidden per-viewer videos feed WebRTC destinations exclusively.
      if (video === localVideoRef.current) source.connect(context.destination);
      const mixer = { context, source };
      audioMixersRef.current.set(video, mixer);
      return mixer;
    } catch {
      void context.close().catch(() => undefined);
      return null;
    }
  }, []);

  const resumeAudioMixer = useCallback((video: HTMLVideoElement) => {
    const mixer = audioMixersRef.current.get(video);
    if (mixer?.context.state === "suspended") {
      void mixer.context.resume().catch(() => undefined);
    }
  }, []);

  const releaseCapturePipeline = useCallback(
    (video: HTMLVideoElement, disposeAudioMixer = false) => {
      const pipeline = capturePipelinesRef.current.get(video);
      if (pipeline) {
        pipeline.stop();
        capturePipelinesRef.current.delete(video);
      }
      if (!disposeAudioMixer) return;

      const mixer = audioMixersRef.current.get(video);
      if (!mixer) return;
      mixer.source.disconnect();
      void mixer.context.close().catch(() => undefined);
      audioMixersRef.current.delete(video);
    },
    [],
  );

  /**
   * Media-element capture can expose only the audio track for some MP4 decode
   * paths. Drawing decoded frames into a canvas produces a stable, codec-neutral
   * video track for WebRTC. Web Audio explicitly folds multichannel sources
   * into stereo so center-channel dialogue is not lost in WebRTC transport.
   */
  const getCaptureStream = useCallback((video: HTMLVideoElement) => {
    const existing = capturePipelinesRef.current.get(video);
    if (existing) return existing.stream;

    const capturable = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const capture = capturable.captureStream || capturable.mozCaptureStream;
    if (!capture) throw new Error("This browser cannot share video playback yet");
    const nativeStream = capture.call(video);
    const nativeAudioTracks = nativeStream.getAudioTracks();
    let outputAudioTracks = nativeAudioTracks;
    let stopAudioMix = () => undefined;

    if (nativeAudioTracks.length) {
      const mixer = ensureAudioMixer(video);
      if (mixer) {
        const destination = mixer.context.createMediaStreamDestination();
        destination.channelCount = 2;
        destination.channelCountMode = "explicit";
        destination.channelInterpretation = "speakers";
        mixer.source.connect(destination);
        resumeAudioMixer(video);
        outputAudioTracks = destination.stream.getAudioTracks();
        stopAudioMix = () => {
          try {
            mixer.source.disconnect(destination);
          } catch {
            /* already disconnected during teardown */
          }
          for (const track of destination.stream.getTracks()) track.stop();
        };
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, video.videoWidth);
    canvas.height = Math.max(2, video.videoHeight);
    const context = canvas.getContext("2d", { alpha: false });
    const canvasCapture = canvas.captureStream?.bind(canvas);
    if (!context || !canvasCapture) {
      if (!nativeStream.getVideoTracks().length) {
        stopAudioMix();
        throw new Error("This browser cannot capture the video's picture");
      }
      const stream = new MediaStream([
        ...nativeStream.getVideoTracks(),
        ...outputAudioTracks,
      ]);
      const pipeline = {
        stream,
        stop: () => {
          stopAudioMix();
          for (const track of nativeStream.getTracks()) track.stop();
        },
      };
      capturePipelinesRef.current.set(video, pipeline);
      return stream;
    }

    const canvasStream = canvasCapture(30);
    const canvasVideoTrack = canvasStream.getVideoTracks()[0];
    if (!canvasVideoTrack) throw new Error("Could not create the compatibility video track");
    canvasVideoTrack.contentHint = "motion";

    let stopped = false;
    let frameHandle = 0;
    let animationHandle = 0;
    const frameVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    const draw = () => {
      if (stopped) return;
      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      if (frameVideo.requestVideoFrameCallback) {
        frameHandle = frameVideo.requestVideoFrameCallback(draw);
      } else {
        animationHandle = window.requestAnimationFrame(draw);
      }
    };
    draw();

    const stream = new MediaStream([
      canvasVideoTrack,
      ...outputAudioTracks,
    ]);
    const pipeline = {
      stream,
      stop: () => {
        stopped = true;
        if (frameHandle) frameVideo.cancelVideoFrameCallback?.(frameHandle);
        if (animationHandle) window.cancelAnimationFrame(animationHandle);
        stopAudioMix();
        for (const track of [...canvasStream.getTracks(), ...nativeStream.getTracks()]) {
          track.stop();
        }
      },
    };
    capturePipelinesRef.current.set(video, pipeline);
    return stream;
  }, [ensureAudioMixer, resumeAudioMixer]);

  const buildPersonalStream = useCallback(
    async (peerId: string) => {
      const peer = peersRef.current.get(peerId);
      if (!peer || !objectUrlRef.current) return null;

      if (peer.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
      peer.personalVideo?.remove();
      const video = document.createElement("video");
      video.src = objectUrlRef.current;
      video.playsInline = true;
      video.preload = "auto";
      video.style.cssText =
        "position:fixed;width:2px;height:2px;opacity:.001;pointer-events:none;left:-10px;bottom:-10px";
      document.body.appendChild(video);
      peer.personalVideo = video;

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Could not prepare the personal stream"));
      });
      const hostVideo = localVideoRef.current;
      if (hostVideo) moveVideoTo(video, hostVideo.currentTime);
      video.playbackRate = peer.playbackRate;
      await video.play().catch(() => undefined);
      return getCaptureStream(video);
    },
    [getCaptureStream, releaseCapturePipeline],
  );

  /**
   * Offering while a previous exchange is still open throws and would leave
   * the track stranded, so an unstable connection is left to the
   * negotiationneeded handler that fires once it settles.
   */
  const renegotiate = useCallback(
    async (peerId: string) => {
      const peer = peersRef.current.get(peerId);
      if (!peer || peer.pc.signalingState !== "stable") return;
      try {
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        await sendSignal(peerId, { description: peer.pc.localDescription });
      } catch {
        /* the next negotiationneeded will pick it back up */
      }
    },
    [sendSignal],
  );

  const attachMediaToPeer = useCallback(
    async (peerId: string, shouldRenegotiate = true) => {
      const peer = peersRef.current.get(peerId);
      const current = sessionRef.current;
      if (!peer || !current?.isHost || !mediaFileRef.current) return;

      let stream: MediaStream | null = null;
      if (modeRef.current === "sync") {
        const video = localVideoRef.current;
        if (video) stream = getCaptureStream(video);
      } else {
        stream = await buildPersonalStream(peerId);
      }
      if (!stream) return;

      peer.audioTrack = stream.getAudioTracks()[0];
      for (const track of stream.getTracks()) {
        const existing = peer.pc.getSenders().find((sender) => sender.track?.kind === track.kind);
        if (existing) await existing.replaceTrack(track);
        else peer.pc.addTrack(track, stream);
      }
      // A muted viewer stays muted across a track swap: the host simply does
      // not put an audio track on that sender.
      if (peer.muted) {
        const audioSender = peer.pc.getSenders().find((s) => s.track?.kind === "audio");
        await audioSender?.replaceTrack(null).catch(() => undefined);
      }
      if (shouldRenegotiate) await renegotiate(peerId);
    },
    [buildPersonalStream, getCaptureStream, renegotiate],
  );

  const videoForPeer = useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    return modeRef.current === "independent" && peer?.personalVideo
      ? peer.personalVideo
      : localVideoRef.current;
  }, []);

  /** Runs on the host: applies a control action and tells the right peers. */
  const applyControl = useCallback(
    async (fromPeer: string | null, action: PlaybackAction, value?: number) => {
      const target = fromPeer ? videoForPeer(fromPeer) : localVideoRef.current;
      if (!target) return;

      if (action === "play") {
        resumeAudioMixer(target);
        await target.play().catch(() => undefined);
      }
      if (action === "pause") target.pause();
      if (action === "seek" && typeof value === "number") moveVideoTo(target, value);
      if (action === "rate" && typeof value === "number" && PLAYBACK_RATES.some((rate) => rate === value)) {
        target.playbackRate = value;
        if (fromPeer) {
          const peer = peersRef.current.get(fromPeer);
          if (peer) peer.playbackRate = value;
        } else if (modeRef.current === "sync") {
          for (const peer of peersRef.current.values()) peer.playbackRate = value;
        }
      }

      if (modeRef.current === "independent") {
        // Each viewer drives their own pipeline here, so a control only ever
        // goes back to the viewer that asked for it — and the host's own
        // player moves nobody else.
        if (fromPeer) await sendSecure(fromPeer, { type: "control", action, value });
        return;
      }
      await broadcastSecure({ type: "control", action, value });
    },
    [broadcastSecure, resumeAudioMixer, sendSecure, videoForPeer],
  );

  const grantControl = useCallback(
    async (peerId: string | null, peerName: string) => {
      setControlHolder(peerId);
      setHolderName(peerName);
      const next: Record<string, Permissions> = {};
      for (const id of peersRef.current.keys()) {
        next[id] = id === peerId ? { ...FULL_CONTROL } : { ...NO_PERMISSIONS };
      }
      permissionsRef.current = next;
      await Promise.all(
        Object.entries(next).map(([id, permissions]) =>
          sendSecure(id, { type: "permission", permissions }),
        ),
      );
      await broadcastSecure({ type: "holder", name: peerId ? peerName : "" });
    },
    [broadcastSecure, sendSecure],
  );

  /* ─── inbound secure messages ─────────────────────────────────────── */

  const teardown = useCallback(
    (message: string) => {
      teardownRef.current = true;
      for (const peer of peersRef.current.values()) {
        if (peer.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
        peer.personalVideo?.remove();
        peer.pc.close();
      }
      if (localVideoRef.current) releaseCapturePipeline(localVideoRef.current, true);
      peersRef.current.clear();
      pendingIceRef.current.clear();
      remoteStreamRef.current = null;
      permissionsRef.current = {};
      keyRef.current = null;
      mediaFileRef.current = null;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
      void mediaCleanupRef.current();
      mediaCleanupRef.current = async () => undefined;
      history.replaceState(null, "", "/");

      setSession(null);
      setScreen("landing");
      setParticipants([]);
      setCodeDraft(null);
      setPrep(-1);
      setFileName("");
      setFileSize(0);
      setConversionProgress(null);
      setPlaying(false);
      setPosition(0);
      setDuration(0);
      setVideoAspect(16 / 9);
      setControlHolder(null);
      setHolderName("");
      setPendingControl(null);
      setPleaSent(false);
      setMutedPeers([]);
      setPeerReadouts({});
      setMyPermissions(NO_PERMISSIONS);
      setSoundOn(false);
      setVolume(1);
      setUserMuted(false);
      setPictureReady(false);
      setSelfMuted(false);
      setNeedsGesture(false);
      setDisconnectedFor(null);
      setQuality("auto");
      setQualityOpen(false);
      setSpeedOpen(false);
      setPlaybackRate(1);
      setSubtitleName("");
      setSubtitleCues([]);
      setSubtitlesOn(false);
      subtitleRef.current = { name: "", cues: [], enabled: false };
      setMode("sync");
      setNativeFullscreen(false);
      setMobileFullscreen(false);
      setControlsVisible(true);
      if (fullscreenControlsTimerRef.current !== null) {
        window.clearTimeout(fullscreenControlsTimerRef.current);
        fullscreenControlsTimerRef.current = null;
      }
      if (message) setToast(message);
      window.setTimeout(() => (teardownRef.current = false), 0);
    },
    [releaseCapturePipeline, setScreen],
  );

  const handleSecureMessage = useCallback(
    async (fromPeer: string, message: SecureMessage) => {
      const current = sessionRef.current;
      if (!current) return;
      const isHost = current.isHost;

      switch (message.type) {
        case "permission":
          if (!isHost) setMyPermissions(message.permissions);
          return;
        case "holder":
          if (!isHost) {
            setHolderName(message.name);
            setPleaSent(false);
          }
          return;
        case "mode":
          if (!isHost) {
            setMode(message.mode);
            notify(
              message.mode === "sync"
                ? "The host locked playback back to their position"
                : "Free seek is on — your stream is your own now",
            );
          }
          return;
        case "media":
          if (!isHost) {
            setFileName(message.name);
            setDuration(message.duration || 0);
            setMode(message.mode);
            if (message.rate) setPlaybackRate(message.rate);
          }
          return;
        case "position":
          if (!isHost) {
            setPosition(message.at);
            setDuration(message.duration || 0);
            setPlaying(message.playing);
            if (message.rate) setPlaybackRate(message.rate);
          }
          return;
        case "control":
          if (!isHost) {
            if (message.action === "rate" && typeof message.value === "number") {
              setPlaybackRate(message.value);
              return;
            }
            const video = remoteVideoRef.current;
            if (!video) return;
            if (message.action === "play") {
              await video.play().catch(() => setNeedsGesture(true));
              setPlaying(!video.paused);
            }
            if (message.action === "pause") {
              video.pause();
              setPlaying(false);
            }
            if (message.action === "seek" && typeof message.value === "number") {
              setPosition(message.value);
            }
          }
          return;
        case "subtitles":
          if (!isHost) {
            setSubtitleName(message.name);
            setSubtitleCues((previous) =>
              message.offset === 0 ? message.cues : [...previous, ...message.cues],
            );
            if (!message.name) setSubtitlesOn(false);
          }
          return;
        case "subtitles-toggle":
          if (!isHost) setSubtitlesOn(message.enabled);
          return;
        case "control-request": {
          if (!isHost) return;
          const granted = permissionsRef.current[fromPeer] || NO_PERMISSIONS;
          const free = modeRef.current === "independent";
          const allowed =
            free || (message.action === "seek" ? granted.seek : granted.playPause);
          if (allowed) await applyControl(fromPeer, message.action, message.value);
          else {
            await sendSecure(fromPeer, {
              type: "notice",
              message: "The host has not handed you playback control",
            });
          }
          return;
        }
        case "control-plea": {
          if (!isHost) return;
          const peer = peersRef.current.get(fromPeer);
          setPendingControl({ id: fromPeer, name: peer?.name || "A viewer", role: "viewer" });
          setPanel("people");
          notify(`${peer?.name || "A viewer"} is asking for playback control`);
          return;
        }
        case "control-plea-result":
          if (!isHost) {
            setPleaSent(false);
            if (!message.granted) notify("The host declined your request");
          }
          return;
        case "quality":
          if (isHost) await setPeerQuality(fromPeer, message.quality);
          return;
        case "mute":
          if (!isHost) {
            setSelfMuted(message.muted);
            notify(message.muted ? "The host muted you" : "The host unmuted you");
          }
          return;
        case "stats":
          if (isHost) {
            setPeerReadouts((previous) => ({
              ...previous,
              [fromPeer]: {
                kbps: message.kbps,
                rtt: message.rtt,
                height: message.height,
                loss: message.loss,
              },
            }));
          }
          return;
        case "rekey": {
          if (isHost) return;
          migratingRef.current = true;
          try {
            keyRef.current = await importRoomKey(message.secret);
            await signalRequest({
              action: "join",
              room: message.code,
              peerId: current.peerId,
              name: name.trim() || "Guest",
            });
            history.replaceState(null, "", `/?room=${message.code}#key=${message.secret}`);
            setSession({ ...current, code: message.code, secret: message.secret });
            notify("The host rotated the invite — you are still connected");
          } catch {
            notify("Could not follow the rotated invite");
          } finally {
            migratingRef.current = false;
          }
          return;
        }
        case "evicted":
          if (!isHost) teardown("The host removed you from the session");
          return;
        case "ended":
          if (!isHost) teardown("The host ended the session · keys destroyed");
          return;
        case "notice":
          notify(message.message);
      }
    },
    [applyControl, name, notify, sendSecure, setPeerQuality, teardown],
  );

  /* ─── peer connections ────────────────────────────────────────────── */

  const setupChannel = useCallback(
    (peerId: string, channel: RTCDataChannel) => {
      const peer = peersRef.current.get(peerId);
      if (peer) peer.channel = channel;
      channel.onopen = async () => {
        const current = sessionRef.current;
        if (!current?.isHost) return;
        await sendSecure(peerId, {
          type: "permission",
          permissions: permissionsRef.current[peerId] || NO_PERMISSIONS,
        });
        await sendSecure(peerId, { type: "mode", mode: modeRef.current });
        await sendSecure(peerId, {
          type: "holder",
          name: holderRef.current ? holderNameRef.current : "",
        });
        if (mediaFileRef.current) {
          await sendSecure(peerId, {
            type: "media",
            name: mediaFileRef.current.name,
            duration: localVideoRef.current?.duration || 0,
            mode: modeRef.current,
            rate: localVideoRef.current?.playbackRate || 1,
          });
        }
        await sendSubtitleTrack(peerId);
      };
      channel.onmessage = async (event) => {
        try {
          const key = keyRef.current;
          if (!key || typeof event.data !== "string") return;
          await handleSecureMessage(peerId, await decryptMessage(key, event.data));
        } catch {
          notify("A control message failed to verify and was dropped");
        }
      };
    },
    [handleSecureMessage, notify, sendSecure, sendSubtitleTrack],
  );

  const createPeer = useCallback(
    async (peerId: string, peerName: string, makeOffer: boolean) => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        bundlePolicy: "max-bundle",
      });
      const peer: PeerState = {
        pc,
        name: peerName,
        muted: false,
        playbackRate: localVideoRef.current?.playbackRate || 1,
        sample: EMPTY_SAMPLE,
      };
      peersRef.current.set(peerId, peer);

      pc.onicecandidate = (event) => {
        if (event.candidate) void sendSignal(peerId, { candidate: event.candidate.toJSON() });
      };
      pc.ontrack = (event) => {
        remoteStreamRef.current = event.streams[0] ?? null;
        attachRemoteStream();
      };
      pc.ondatachannel = (event) => setupChannel(peerId, event.channel);
      // Only the host ever adds tracks, so only the host offers.
      if (makeOffer) pc.onnegotiationneeded = () => void renegotiate(peerId);
      pc.onconnectionstatechange = () => {
        const current = sessionRef.current;
        const lost = ["failed", "disconnected"].includes(pc.connectionState);
        if (current && !current.isHost && peerId === current.hostId) {
          if (lost) setCountdown(RECONNECT_WINDOW);
          setDisconnectedFor(lost ? Date.now() : null);
        }
      };

      if (makeOffer) {
        setupChannel(peerId, pc.createDataChannel("relay-control", { ordered: true }));
        if (mediaFileRef.current) await attachMediaToPeer(peerId, false);
        await renegotiate(peerId);
      }
      return peer;
    },
    [attachMediaToPeer, attachRemoteStream, renegotiate, sendSignal, setupChannel],
  );

  const handleSignalEvent = useCallback(
    async (event: {
      type: "peer-joined" | "peer-left" | "signal";
      from: string;
      data?: {
        name?: string;
        description?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
    }) => {
      const current = sessionRef.current;
      if (!current) return;

      if (event.type === "peer-joined" && current.isHost) {
        // A rejoin after an invite rotation must not reset what the viewer
        // was already allowed to do.
        if (!permissionsRef.current[event.from]) {
          permissionsRef.current = {
            ...permissionsRef.current,
            [event.from]: { ...NO_PERMISSIONS },
          };
        }
        await createPeer(event.from, event.data?.name || "Guest", true);
        return;
      }
      if (event.type === "peer-left") {
        const peer = peersRef.current.get(event.from);
        if (peer?.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
        peer?.personalVideo?.remove();
        peer?.pc.close();
        peersRef.current.delete(event.from);
        setParticipants((items) => items.filter((item) => item.id !== event.from));
        setPeerReadouts((previous) => {
          const next = { ...previous };
          delete next[event.from];
          return next;
        });
        setPendingControl((item) => (item?.id === event.from ? null : item));
        if (holderRef.current === event.from) {
          setControlHolder(null);
          setHolderName("");
        }
        return;
      }
      if (event.type !== "signal" || !event.data) return;

      const peer =
        peersRef.current.get(event.from) || (await createPeer(event.from, "Peer", false));

      if (event.data.description) {
        await peer.pc.setRemoteDescription(event.data.description);
        for (const candidate of pendingIceRef.current.get(event.from) || []) {
          await peer.pc.addIceCandidate(candidate).catch(() => undefined);
        }
        pendingIceRef.current.delete(event.from);

        if (event.data.description.type === "offer") {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          await sendSignal(event.from, { description: peer.pc.localDescription });
        }
      } else if (event.data.candidate) {
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(event.data.candidate).catch(() => undefined);
        } else {
          const queue = pendingIceRef.current.get(event.from) || [];
          queue.push(event.data.candidate);
          pendingIceRef.current.set(event.from, queue);
        }
      }
    },
    [createPeer, releaseCapturePipeline, sendSignal],
  );

  /* ─── signalling poll ─────────────────────────────────────────────── */

  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    const poll = async () => {
      if (pollBusyRef.current || cancelled || migratingRef.current) return;
      pollBusyRef.current = true;
      try {
        const response = await fetch(
          `/api/signal?room=${encodeURIComponent(session.code)}&peer=${encodeURIComponent(session.peerId)}`,
          { cache: "no-store" },
        );
        if (response.status === 404) {
          if (!session.isHost && !migratingRef.current && !teardownRef.current) {
            teardown("The session ended — nothing was kept");
          }
          return;
        }
        const data = (await response.json()) as {
          events: Parameters<typeof handleSignalEvent>[0][];
          participants: Participant[];
        };
        setParticipants(data.participants);
        for (const item of data.events) await handleSignalEvent(item);
      } catch {
        /* a dropped poll is retried on the next tick */
      } finally {
        pollBusyRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(poll, 850);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [handleSignalEvent, session, teardown]);

  /* ─── transport sampling ──────────────────────────────────────────── */

  useEffect(() => {
    if (screen !== "room" || !session) return;
    const timer = window.setInterval(async () => {
      if (session.isHost) {
        const updates: Record<string, PeerReadout> = {};
        let total = EMPTY_SAMPLE;
        for (const [peerId, peer] of peersRef.current) {
          peer.sample = await sampleTransport(peer.pc, "outbound", peer.sample);
          updates[peerId] = {
            kbps: peer.sample.kbps,
            rtt: Math.round(peer.sample.rtt),
            height: peer.sample.height,
            loss: peer.sample.loss,
          };
          total = {
            ...total,
            kbps: total.kbps + peer.sample.kbps,
            rtt: Math.max(total.rtt, peer.sample.rtt),
            loss: Math.max(total.loss, peer.sample.loss),
            height: Math.max(total.height, peer.sample.height),
          };
        }
        // A viewer's own report beats the host's outbound guess when it arrives.
        setPeerReadouts((previous) => {
          const merged: Record<string, PeerReadout> = {};
          for (const [peerId, local] of Object.entries(updates)) {
            const reported = previous[peerId];
            merged[peerId] = reported?.height ? reported : local;
          }
          return merged;
        });
        setOwnSample(total);
      } else {
        const peer = peersRef.current.get(session.hostId);
        if (!peer) return;
        peer.sample = await sampleTransport(peer.pc, "inbound", peer.sample);
        setOwnSample(peer.sample);
        await sendSecure(session.hostId, {
          type: "stats",
          kbps: peer.sample.kbps,
          rtt: Math.round(peer.sample.rtt),
          height: peer.sample.height,
          loss: Math.round(peer.sample.loss),
        });
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [screen, sendSecure, session]);

  /* ─── the host publishes its playhead ─────────────────────────────── */

  useEffect(() => {
    if (screen !== "room" || !session?.isHost) return;
    const timer = window.setInterval(() => {
      if (modeRef.current === "sync") {
        const video = localVideoRef.current;
        if (!video) return;
        void broadcastSecure({
          type: "position",
          at: video.currentTime,
          duration: video.duration || 0,
          playing: !video.paused,
          rate: video.playbackRate,
        });
        return;
      }
      for (const [peerId, peer] of peersRef.current) {
        const video = peer.personalVideo;
        if (!video) continue;
        void sendSecure(peerId, {
          type: "position",
          at: video.currentTime,
          duration: video.duration || 0,
          playing: !video.paused,
          rate: video.playbackRate,
        });
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [broadcastSecure, screen, sendSecure, session]);

  /* ─── the reconnect window a viewer gets when the host drops ──────── */

  useEffect(() => {
    if (disconnectedFor === null) return;
    const timer = window.setInterval(() => {
      const left = RECONNECT_WINDOW - Math.floor((Date.now() - disconnectedFor) / 1000);
      if (left <= 0) {
        teardown("The host did not come back — the session and its keys are gone");
      } else {
        setCountdown(left);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [disconnectedFor, teardown]);

  useEffect(() => {
    const onUnload = () => {
      const current = sessionRef.current;
      if (!current) return;
      navigator.sendBeacon(
        "/api/signal",
        new Blob(
          [JSON.stringify({ action: "leave", room: current.code, peerId: current.peerId })],
          { type: "application/json" },
        ),
      );
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      for (const peer of peersRef.current.values()) {
        if (peer.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
        peer.personalVideo?.remove();
        peer.pc.close();
      }
      if (localVideoRef.current) releaseCapturePipeline(localVideoRef.current, true);
      void mediaCleanupRef.current();
    },
    [releaseCapturePipeline],
  );

  /* ─── host setup ──────────────────────────────────────────────────── */

  const loadFile = useCallback(
    async (file: File) => {
      setError("");
      setFileName(file.name);
      setFileSize(file.size);
      setConversionProgress(null);
      mediaFileRef.current = file;

      try {
        setPrep(0);
        const prepared = await preparePlayableVideo(file, setConversionProgress);
        setConversionProgress(null);
        setDuration(prepared.duration);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        await mediaCleanupRef.current();
        mediaCleanupRef.current = prepared.cleanup;
        objectUrlRef.current = URL.createObjectURL(prepared.source);

        setPrep(1);
        const secret = makeSecret();
        keyRef.current = await importRoomKey(secret);

        setPrep(2);
        const peerId = crypto.randomUUID();
        const code = await claimRoom(peerId, name.trim() || "Host");

        setPrep(3);
        setCodeDraft({ code, secret });
        setSession({ code, secret, peerId, hostId: peerId, isHost: true });
        setParticipants([{ id: peerId, name: name.trim() || "Host", role: "host" }]);
        history.replaceState(null, "", `/?room=${code}#key=${secret}`);
      } catch (setupError) {
        setPrep(-1);
        mediaFileRef.current = null;
        setFileName("");
        setConversionProgress(null);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = "";
        await mediaCleanupRef.current();
        mediaCleanupRef.current = async () => undefined;
        setError(
          setupError instanceof Error ? setupError.message : "Could not open the session",
        );
      }
    },
    [name],
  );

  /** Swapping the file mid-session keeps the room, the key and the peers. */
  const replaceVideo = useCallback(
    async (file: File) => {
      const video = localVideoRef.current;
      if (!video) return;
      const rate = video.playbackRate || 1;
      notify("Preparing " + file.name + " locally");

      try {
        let lastProgress = -1;
        const prepared = await preparePlayableVideo(file, (progress) => {
          const percent = Math.round(progress * 100);
          if (percent === lastProgress) return;
          lastProgress = percent;
          setToast(`Converting locally · ${percent}%`);
        });

        releaseCapturePipeline(video);
        for (const peer of peersRef.current.values()) {
          if (peer.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        await mediaCleanupRef.current();
        mediaCleanupRef.current = prepared.cleanup;
        objectUrlRef.current = URL.createObjectURL(prepared.source);
        mediaFileRef.current = file;
        setFileName(file.name);
        setFileSize(file.size);
        setPosition(0);
        const clearedSubtitles = { name: "", cues: [], enabled: false };
        subtitleRef.current = clearedSubtitles;
        setSubtitleName("");
        setSubtitleCues([]);
        setSubtitlesOn(false);

        video.src = objectUrlRef.current;
        await new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error("Could not open the prepared video"));
          video.load();
        });
        setDuration(video.duration || prepared.duration);
        video.playbackRate = rate;
        await video.play().catch(() => undefined);
        await Promise.all([...peersRef.current.keys()].map((id) => attachMediaToPeer(id)));
        await Promise.all(
          [...peersRef.current.keys()].map((id) => sendSubtitleTrack(id, clearedSubtitles)),
        );
        await broadcastSecure({
          type: "media",
          name: file.name,
          duration: video.duration || prepared.duration,
          mode: modeRef.current,
          rate,
        });
        notify("Now sharing " + file.name);
      } catch (replaceError) {
        notify(
          replaceError instanceof Error ? replaceError.message : "Could not prepare that video",
        );
      }
    },
    [
      attachMediaToPeer,
      broadcastSecure,
      notify,
      releaseCapturePipeline,
      sendSubtitleTrack,
    ],
  );

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void (screen === "room" ? replaceVideo(file) : loadFile(file));
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };

  function openRoom() {
    setScreen("room");
    setPanel("people");
  }

  // The stage's <video> mounts with the room, so the source is attached and
  // the capture handed to anyone who joined while the code was still on screen.
  useEffect(() => {
    if (screen !== "room" || !session?.isHost) return;
    const video = localVideoRef.current;
    if (!video || !objectUrlRef.current) return;
    let cancelled = false;

    const start = async () => {
      if (video.src !== objectUrlRef.current) video.src = objectUrlRef.current;
      try {
        await video.play();
        if (!cancelled) setNeedsGesture(false);
      } catch {
        if (!cancelled) setNeedsGesture(true);
      }
      if (cancelled) return;
      setPlaying(!video.paused);
      await Promise.all([...peersRef.current.keys()].map((id) => attachMediaToPeer(id)));
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [attachMediaToPeer, screen, session]);

  // A remote track can arrive before the stage has mounted, so the stream is
  // held in a ref and attached from both sides.
  useEffect(() => {
    if (screen !== "room" || !session || session.isHost) return;
    attachRemoteStream();
  }, [attachRemoteStream, screen, session]);

  /* ─── volume ──────────────────────────────────────────────────────── */

  const isHost = Boolean(session?.isHost);
  const iHoldControl = isHost || myPermissions.playPause || mode === "independent";
  const canSeek = isHost || myPermissions.seek || mode === "independent";

  const activeVideo = useCallback(
    () => (sessionRef.current?.isHost ? localVideoRef : remoteVideoRef).current,
    [],
  );

  const hostSilencedMe = !isHost && selfMuted;
  const audioBlocked = !isHost && !soundOn;
  const muted = hostSilencedMe || audioBlocked || userMuted || volume === 0;

  useEffect(() => {
    audioRef.current = { volume, muted };
    const video = activeVideo();
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [activeVideo, muted, screen, volume]);

  /** Any deliberate touch of the volume clears the viewer's autoplay gate. */
  const openAudio = useCallback(() => {
    if (hostSilencedMe) return false;
    setSoundOn(true);
    const video = activeVideo();
    if (video) {
      resumeAudioMixer(video);
      void video.play().catch(() => undefined);
    }
    return true;
  }, [activeVideo, hostSilencedMe, resumeAudioMixer]);

  const changeVolume = useCallback(
    (next: number) => {
      if (!openAudio()) return;
      setVolume(next);
      setUserMuted(next === 0);
    },
    [openAudio],
  );

  const toggleMute = useCallback(() => {
    if (hostSilencedMe) {
      notify("The host has muted you");
      return;
    }
    const wasSilent = audioBlocked || userMuted || volume === 0;
    openAudio();
    setUserMuted(!wasSilent);
    if (wasSilent && volume === 0) setVolume(1);
  }, [audioBlocked, hostSilencedMe, notify, openAudio, userMuted, volume]);

  async function startPlayback() {
    if (!session?.isHost) {
      openAudio();
      setNeedsGesture(Boolean(remoteVideoRef.current?.paused));
      return;
    }
    const video = localVideoRef.current;
    if (!video) return;
    resumeAudioMixer(video);
    await video.play().catch(() => undefined);
    setNeedsGesture(video.paused);
    setPlaying(!video.paused);
    await Promise.all([...peersRef.current.keys()].map((id) => attachMediaToPeer(id)));
  }

  /* ─── join ────────────────────────────────────────────────────────── */

  function onJoinInput(value: string) {
    setJoinDraft(value);
    setError("");
    const parsed = parseInvite(value);
    if (parsed.secret) setKeyInput(parsed.secret);
    setKeyPrompt(Boolean(parsed.code) && !parsed.secret && !keyInput);
  }

  async function submitJoin() {
    const parsed = parseInvite(joinInput);
    if (!parsed.code) {
      setError("Enter the six digits, the word phrase, or the invite link.");
      return;
    }
    const secret = parsed.secret || keyInput.trim();
    if (!secret) {
      setKeyPrompt(true);
      setError("This code needs its invite key. Paste the full link, or the key below.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      keyRef.current = await importRoomKey(secret);
      const peerId = crypto.randomUUID();
      const result = (await signalRequest({
        action: "join",
        room: parsed.code,
        peerId,
        name: name.trim() || "Guest",
      })) as { hostId: string };
      history.replaceState(null, "", `/?room=${parsed.code}#key=${secret}`);
      setSession({
        code: parsed.code,
        secret,
        peerId,
        hostId: result.hostId,
        isHost: false,
      });
      setScreen("room");
      setPanel("people");
    } catch (joinError) {
      setError(
        joinError instanceof Error
          ? joinError.message
          : "No live session for that code. Codes die with the session — ask the host to resend.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ─── room actions ────────────────────────────────────────────────── */

  const togglePlay = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    if (current.isHost) {
      const video = localVideoRef.current;
      if (!video) return;
      await applyControl(null, video.paused ? "play" : "pause");
      setPlaying(!video.paused);
      return;
    }
    if (!iHoldControl) {
      notify("Only the host controls playback in this session");
      return;
    }
    await sendSecure(current.hostId, {
      type: "control-request",
      action: playing ? "pause" : "play",
    });
  }, [applyControl, iHoldControl, notify, playing, sendSecure]);

  // Space and K play or pause, M mutes — but never while the caret is in a
  // field or a dialog has the room's attention.
  useEffect(() => {
    if (screen !== "room" || privacyOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === " ") {
        // A focused button already activates on space; don't toggle twice.
        if (["BUTTON", "A"].includes(target?.tagName ?? "")) return;
        event.preventDefault();
        void togglePlay();
      } else if (key === "k") {
        event.preventDefault();
        void togglePlay();
      } else if (key === "m") {
        event.preventDefault();
        toggleMute();
      } else if (key === "escape" && mobileFullscreen) {
        event.preventDefault();
        setMobileFullscreen(false);
        setControlsVisible(true);
        screen.orientation?.unlock?.();
      } else if (key === "f") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileFullscreen, privacyOpen, screen, toggleMute, togglePlay]);

  async function seekTo(seconds: number) {
    if (!session || !duration) return;
    const value = Math.min(duration, Math.max(0, seconds));
    if (isHost) {
      setPosition(value);
      await applyControl(null, "seek", value);
      return;
    }
    if (!canSeek) {
      notify("The host is driving the timeline — request control to scrub");
      return;
    }
    setPosition(value);
    await sendSecure(session.hostId, { type: "control-request", action: "seek", value });
  }

  function ratioFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function onScrubPointer(event: PointerEvent<HTMLDivElement>) {
    if (!duration) return;
    void seekTo(ratioFromPointer(event) * duration);
  }

  function onScrubKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!duration) return;
    // Space is handled globally, so the scrubber only owns the arrows.
    const step = event.shiftKey ? 30 : 5;
    if (event.key === "ArrowRight") void seekTo(position + step);
    else if (event.key === "ArrowLeft") void seekTo(position - step);
    else return;
    event.preventDefault();
  }

  async function chooseQuality(next: Quality) {
    setQuality(next);
    setQualityOpen(false);
    if (!session) return;
    if (isHost) {
      await Promise.all([...peersRef.current.keys()].map((id) => setPeerQuality(id, next)));
    } else {
      await sendSecure(session.hostId, { type: "quality", quality: next });
    }
    notify(next === "auto" ? "Quality: Auto — adapts to the link" : `Capped at ${next}p`);
  }

  async function choosePlaybackRate(next: number) {
    setSpeedOpen(false);
    if (!session) return;
    if (!iHoldControl) {
      notify("Playback speed follows the host in this session");
      return;
    }
    setPlaybackRate(next);
    if (isHost) {
      await applyControl(null, "rate", next);
    } else {
      await sendSecure(session.hostId, {
        type: "control-request",
        action: "rate",
        value: next,
      });
    }
    notify(`Playback speed: ${next}×`);
  }

  async function onSubtitleInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2_000_000) {
      notify("Subtitle files must be smaller than 2 MB");
      return;
    }
    const cues = parseSubtitleFile(await file.text());
    if (!cues.length) {
      notify("No readable cues found — choose an SRT or WebVTT file");
      return;
    }
    const track = { name: file.name, cues, enabled: true };
    subtitleRef.current = track;
    setSubtitleName(file.name);
    setSubtitleCues(cues);
    setSubtitlesOn(true);
    await Promise.all([...peersRef.current.keys()].map((id) => sendSubtitleTrack(id, track)));
    notify(`${file.name} added · ${cues.length} subtitle cues`);
  }

  async function toggleSubtitles() {
    if (!subtitleCues.length) {
      if (isHost) subtitleInputRef.current?.click();
      else notify("The host has not added subtitles");
      return;
    }
    const enabled = !subtitlesOn;
    setSubtitlesOn(enabled);
    subtitleRef.current = { ...subtitleRef.current, enabled };
    if (isHost) await broadcastSecure({ type: "subtitles-toggle", enabled });
    notify(enabled ? "Subtitles on" : "Subtitles off");
  }

  async function toggleSyncLock() {
    if (!session?.isHost) return;
    const next: PlaybackMode = mode === "sync" ? "independent" : "sync";
    setMode(next);
    modeRef.current = next;
    if (next === "independent") {
      const rate = localVideoRef.current?.playbackRate || 1;
      for (const peer of peersRef.current.values()) peer.playbackRate = rate;
    }
    await Promise.all([...peersRef.current.keys()].map((id) => attachMediaToPeer(id)));
    await broadcastSecure({ type: "mode", mode: next });
    notify(
      next === "sync"
        ? "Everyone snapped back to your position"
        : "Viewers may seek their own stream now",
    );
  }

  async function muteViewer(peerId: string, muted: boolean) {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    peer.muted = muted;
    const sender = peer.pc.getSenders().find((item) => item.track?.kind === "audio");
    // Dropping the track from that one sender is what actually silences them;
    // the message only keeps their UI honest about it.
    await sender?.replaceTrack(muted ? null : peer.audioTrack ?? null).catch(() => undefined);
    await sendSecure(peerId, { type: "mute", muted });
    setMutedPeers((previous) =>
      muted ? [...new Set([...previous, peerId])] : previous.filter((id) => id !== peerId),
    );
  }

  async function muteEveryone() {
    await Promise.all([...peersRef.current.keys()].map((id) => muteViewer(id, true)));
    notify("All viewers muted");
  }

  async function removeViewer(peerId: string, peerName: string) {
    const current = sessionRef.current;
    if (!current) return;
    await sendSecure(peerId, { type: "evicted" });
    const peer = peersRef.current.get(peerId);
    if (peer?.personalVideo) releaseCapturePipeline(peer.personalVideo, true);
    peer?.personalVideo?.remove();
    peer?.pc.close();
    peersRef.current.delete(peerId);
    delete permissionsRef.current[peerId];
    await signalRequest(
      { action: "evict", room: current.code, peerId: current.peerId, to: peerId },
      { allowNotFound: true },
    ).catch(() => undefined);
    setParticipants((items) => items.filter((item) => item.id !== peerId));
    notify(`${peerName} removed · their stream is cut`);
  }

  async function requestControl() {
    if (!session || pleaSent) return;
    setPleaSent(true);
    await sendSecure(session.hostId, { type: "control-plea" });
    notify("Asked the host for control");
  }

  async function resolvePending(granted: boolean) {
    const request = pendingControl;
    if (!request) return;
    setPendingControl(null);
    await sendSecure(request.id, { type: "control-plea-result", granted });
    if (granted) {
      await grantControl(request.id, request.name);
      notify(`${request.name} can now pause and seek`);
    } else {
      notify("Request declined");
    }
  }

  async function toggleViewerControl(peerId: string, peerName: string) {
    const holding = controlHolder === peerId;
    await grantControl(holding ? null : peerId, holding ? "" : peerName);
    notify(holding ? "Control returned to you" : `${peerName} can now pause and seek`);
  }

  async function rotateInvite() {
    const current = sessionRef.current;
    if (!current?.isHost) return;
    setBusy(true);
    try {
      const secret = makeSecret();
      const code = await claimRoom(current.peerId, name.trim() || "Host");
      // Connected viewers are told over the old key, then move their
      // signalling seat across; the old room is torn down behind them.
      await broadcastSecure({ type: "rekey", code, secret });
      keyRef.current = await importRoomKey(secret);
      const previousCode = current.code;
      setSession({ ...current, code, secret });
      setCodeDraft({ code, secret });
      history.replaceState(null, "", `/?room=${code}#key=${secret}`);
      window.setTimeout(() => {
        void signalRequest(
          { action: "leave", room: previousCode, peerId: current.peerId },
          { allowNotFound: true },
        ).catch(() => undefined);
      }, 2000);
      notify("New invite issued · the old one no longer admits anyone");
    } catch {
      notify("Could not rotate the invite");
    } finally {
      setBusy(false);
    }
  }

  async function endSession() {
    const current = sessionRef.current;
    if (!current) return;
    if (current.isHost) await broadcastSecure({ type: "ended" });
    await signalRequest(
      { action: "leave", room: current.code, peerId: current.peerId },
      { allowNotFound: true },
    ).catch(() => undefined);
    teardown(
      current.isHost ? "Session ended · keys destroyed, nothing retained" : "You left the session",
    );
  }

  async function copyCode() {
    if (!session) return;
    const text = renderCode(codeFormat, session.code, session.secret, origin);
    await navigator.clipboard.writeText(text).catch(() => undefined);
    notify(
      codeFormat === "link"
        ? "Invite copied — it expires when you close the tab"
        : "Code copied — send the link too, it carries the key",
    );
  }

  const clearFullscreenControlsTimer = useCallback(() => {
    if (fullscreenControlsTimerRef.current === null) return;
    window.clearTimeout(fullscreenControlsTimerRef.current);
    fullscreenControlsTimerRef.current = null;
  }, []);

  const revealFullscreenControls = useCallback(() => {
    setControlsVisible(true);
    clearFullscreenControlsTimer();
    if (
      (document.fullscreenElement === stageRef.current || mobileFullscreen) &&
      !activeVideo()?.paused &&
      !qualityOpen &&
      !speedOpen
    ) {
      fullscreenControlsTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
        fullscreenControlsTimerRef.current = null;
      }, FULLSCREEN_CONTROLS_DELAY);
    }
  }, [
    activeVideo,
    clearFullscreenControlsTimer,
    mobileFullscreen,
    qualityOpen,
    speedOpen,
  ]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === stageRef.current;
      setNativeFullscreen(active);
      setControlsVisible(true);
      clearFullscreenControlsTimer();
      if (!active) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [clearFullscreenControlsTimer]);

  useEffect(() => {
    if (!mobileFullscreen) return;
    document.documentElement.classList.add("relay-fullscreen-lock");
    return () => document.documentElement.classList.remove("relay-fullscreen-lock");
  }, [mobileFullscreen]);

  useEffect(() => {
    if (isFullscreen && playing) revealFullscreenControls();
    else {
      clearFullscreenControlsTimer();
      setControlsVisible(true);
    }
  }, [
    clearFullscreenControlsTimer,
    isFullscreen,
    playing,
    qualityOpen,
    revealFullscreenControls,
    speedOpen,
  ]);

  useEffect(() => clearFullscreenControlsTimer, [clearFullscreenControlsTimer]);

  async function toggleFullscreen() {
    const node = stageRef.current;
    if (!node) return;

    if (mobileFullscreen) {
      setMobileFullscreen(false);
      setControlsVisible(true);
      screen.orientation?.unlock?.();
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    try {
      await node.requestFullscreen();
      if (navigator.maxTouchPoints > 0 || window.innerWidth <= 900) {
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (orientation: OrientationLockType) => Promise<void>;
        };
        await orientation.lock?.("landscape").catch(() => undefined);
      }
    } catch {
      // iPhone Safari does not support fullscreen on arbitrary elements.
      // Keep Relay's controls and subtitles by using a fixed immersive stage.
      if (navigator.maxTouchPoints > 0 || window.innerWidth <= 900) {
        setMobileFullscreen(true);
        setControlsVisible(true);
      }
    }
  }

  /* ─── derived view state ──────────────────────────────────────────── */

  const codeText = session
    ? renderCode(codeFormat, session.code, session.secret, origin)
    : codeDraft
      ? renderCode(codeFormat, codeDraft.code, codeDraft.secret, origin)
      : "";

  const qr = useMemo(
    () => (codeFormat === "link" && codeText ? qrPath(codeText) : null),
    [codeFormat, codeText],
  );

  const offline = disconnectedFor !== null;
  const weakLink =
    !offline &&
    ((ownSample.kbps > 0 && ownSample.kbps < WEAK_KBPS) || ownSample.loss > WEAK_LOSS);
  const deliveredRung = rungForHeight(ownSample.height);
  const effectiveQuality = offline
    ? "—"
    : deliveredRung || (quality === "auto" ? "negotiating" : `${quality}p`);
  const qualityButtonLabel =
    quality === "auto" ? (deliveredRung ? `Auto ${deliveredRung}` : "Auto") : `${quality}p`;
  const viewers = participants.filter((item) => item.role !== "host");
  const host = participants.find((item) => item.role === "host");
  const playedPct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const bufferPct = duration ? Math.min(100, Math.max(playedPct, (buffered / duration) * 100)) : 0;
  const controlLabel = holderName
    ? `${holderName} has control`
    : isHost
      ? "you control playback"
      : "host controls playback";
  const roomMeta = `${participants.length} watching · ${effectiveQuality} · ${formatRate(ownSample.kbps)}`;
  const activeSubtitle = subtitlesOn
    ? subtitleCues
        .filter((cue) => position >= cue.start && position <= cue.end)
        .map((cue) => cue.text)
        .join("\n")
    : "";

  const completedPrep =
    prep < 0
      ? 0
      : prep + (prep === 0 ? conversionProgress ?? 0 : 1);
  const prepPct = Math.round((completedPrep / PREP_STEPS.length) * 100);
  const hasCode = prep === PREP_STEPS.length - 1 && Boolean(codeDraft);

  /* ─── render ──────────────────────────────────────────────────────── */

  const trustTable = (
    <table className="table table-inset">
      <tbody>
        {TRUST_ROWS.map(([label, value]) => (
          <tr key={label}>
            <td className="k">{label}</td>
            <td className="v">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const codeTabs = (
    <div className="seg" role="tablist" aria-label="Invite format">
      {CODE_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="seg-opt"
          aria-selected={codeFormat === tab.id}
          onClick={() => setCodeFormat(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">RELAY</span>
        {session && screen === "room" && (
          <span className="nav-code">{formatRoomCode(session.code)}</span>
        )}
        <div className="nav-spacer" />
        {session && screen === "room" && (
          <span className="tag tag-accent">
            <LockIcon size={12} strokeWidth={2.5} />
            E2EE · {participants.length} peers
          </span>
        )}
        <span className="nav-me">{isHost ? "YOU · HOST" : name.trim() || "YOU"}</span>
      </nav>

      <div className="body">
        {screen === "landing" && (
          <div className="screen screen-landing">
            <div className="hero">
              <h1>Share a video without uploading it.</h1>
              <p>
                Nothing is uploaded. Your device streams the video straight to each viewer over
                an encrypted peer connection — the server only introduces the peers and carries
                no video, no load, no copy. Close the tab and the session ceases to exist.
              </p>
            </div>
            <hr className="hr" />
            <div className="choices">
              <button type="button" className="choice" onClick={() => setScreen("host")}>
                <span className="card-kicker">HOST</span>
                <span className="choice-title">Share a video</span>
                <span className="choice-body">
                  Pick a file on this device, get a code. It streams from here and you drive
                  playback.
                </span>
              </button>
              <button type="button" className="choice" onClick={() => setScreen("join")}>
                <span className="card-kicker card-kicker-dim">VIEWER</span>
                <span className="choice-title">Join with a code</span>
                <span className="choice-body">
                  Six digits, a word phrase, or a link someone sent you.
                </span>
              </button>
            </div>
            <div className="claim-row">
              <span className="lbl">No upload</span>
              <span className="lbl">Server = signalling only</span>
              <span className="lbl">Keys stay local</span>
              <button type="button" className="btn btn-ghost" onClick={() => setPrivacyOpen(true)}>
                How it works
              </button>
            </div>
          </div>
        )}

        {screen === "host" && (
          <div className="screen screen-narrow">
            <div className="step-head">
              <span className="lbl step-kicker">STEP {hasCode ? 2 : 1} / 2</span>
              <h2>
                {hasCode
                  ? "Share this code"
                  : prep >= 0
                    ? "Opening an encrypted session"
                    : "Pick the video to share"}
              </h2>
            </div>

            {prep < 0 && (
              <div className="stack-4">
                <div className="field">
                  <label htmlFor="host-name">Your display name</label>
                  <input
                    className="input"
                    id="host-name"
                    value={name}
                    onChange={(event) => setName(event.target.value.slice(0, 40))}
                    placeholder="Host"
                    autoComplete="nickname"
                  />
                </div>
                <button
                  type="button"
                  className={`dropzone${dragging ? " is-over" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <PlusIcon />
                  <span className="dropzone-title">Choose a video on this device</span>
                  <span className="mono prep-meta">
                    mp4 · mkv · webm · mov · ts · ogg — stays local
                  </span>
                </button>
                <div className="note">
                  <span>
                    Nothing uploads. Compatible files stream from disk; other containers are
                    normalized in temporary browser-private storage. The server only passes
                    connection details along.
                  </span>
                </div>
                {error && (
                  <div className="note note-alert" role="alert">
                    <AlertIcon />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            )}

            {prep >= 0 && !hasCode && (
              <div className="prep">
                <div className="prep-file">
                  <div className="prep-thumb" />
                  <div style={{ minWidth: 0 }}>
                    <div className="prep-name">{fileName}</div>
                    <div className="prep-meta">
                      {formatBytes(fileSize)}
                      {duration ? ` · ${formatTime(duration)}` : ""}
                    </div>
                  </div>
                </div>
                <div className="stack-2">
                  <div className="meter-row">
                    <span>
                      {conversionProgress !== null
                        ? `Normalizing format locally · ${Math.round(conversionProgress * 100)}%`
                        : PREP_STEPS[Math.max(0, prep)]}
                    </span>
                    <span>{prepPct}%</span>
                  </div>
                  <div className="meter">
                    <span style={{ width: `${prepPct}%` }} />
                  </div>
                  <span className="lbl">Nothing has left the device</span>
                </div>
              </div>
            )}

            {hasCode && codeDraft && (
              <div className="stack-4">
                {codeTabs}
                <div className="code-block">
                  {qr && (
                    <div className="qr">
                      <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Invite QR code">
                        <path d={qr.path} fill="#0d0d0f" />
                      </svg>
                    </div>
                  )}
                  <div className="stack-2" style={{ minWidth: 0 }}>
                    <span className={`code-value${codeFormat === "numeric" ? " is-numeric" : ""}`}>
                      {codeText}
                    </span>
                    <span className="lbl">
                      {codeFormat === "link"
                        ? "Carries the key · valid while this tab stays open"
                        : "Room id only — send the link for the key"}
                    </span>
                  </div>
                </div>
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" onClick={openRoom}>
                    Open room
                    <ArrowRightIcon />
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={copyCode}>
                    <CopyIcon />
                    Copy
                  </button>
                </div>
                <div className="foot-row">
                  <span>Nothing is stored on our side — the code is a pointer, not a record.</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setPrivacyOpen(true)}
                  >
                    Details
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {screen === "join" && (
          <div className="screen screen-tight">
            <h2>Enter the code you were given</h2>
            <div className="field">
              <label htmlFor="join-name">Your display name</label>
              <input
                className="input"
                id="join-name"
                value={name}
                onChange={(event) => setName(event.target.value.slice(0, 40))}
                placeholder="Guest"
                autoComplete="nickname"
              />
            </div>
            <div className="field">
              <label htmlFor="join-code">Session code</label>
              <input
                className={`input input-code${error ? " input-invalid" : ""}`}
                id="join-code"
                value={joinInput}
                onChange={(event) => onJoinInput(event.target.value)}
                placeholder="472 913"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {needsKey && (
              <div className="field">
                <label htmlFor="join-key">Invite key</label>
                <input
                  className="input mono"
                  id="join-key"
                  type="password"
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  placeholder="From the invite link, after #key="
                  autoComplete="off"
                />
              </div>
            )}
            {error && (
              <div className="note note-alert" role="alert">
                <AlertIcon />
                <span>{error}</span>
              </div>
            )}
            <span className="lbl">Also accepts a word phrase or a full invite link</span>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={submitJoin}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Join session"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setScreen("landing")}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {screen === "room" && session && (
          <div className="room">
            <div className="room-main">
              <div
                className={`stage${mobileFullscreen ? " is-mobile-fullscreen" : ""}${
                  isFullscreen && !controlsVisible ? " is-controls-hidden" : ""
                }`}
                ref={stageRef}
                style={{ "--video-aspect": videoAspect } as CSSProperties}
                onPointerMove={() => {
                  if (isFullscreen) revealFullscreenControls();
                }}
                onPointerDown={() => {
                  if (isFullscreen) revealFullscreenControls();
                }}
                onFocusCapture={() => {
                  if (isFullscreen) revealFullscreenControls();
                }}
              >
                {isHost ? (
                  <video
                    ref={localVideoRef}
                    playsInline
                    onTimeUpdate={(event) => {
                      setPosition(event.currentTarget.currentTime);
                      const ranges = event.currentTarget.buffered;
                      setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
                    }}
                    onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
                    onLoadedMetadata={(event) => rememberVideoAspect(event.currentTarget)}
                    onResize={(event) => rememberVideoAspect(event.currentTarget)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                  />
                ) : (
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    onLoadedMetadata={(event) => {
                      setPictureReady(event.currentTarget.videoWidth > 0);
                      rememberVideoAspect(event.currentTarget);
                    }}
                    onResize={(event) => {
                      setPictureReady(event.currentTarget.videoWidth > 0);
                      rememberVideoAspect(event.currentTarget);
                    }}
                  />
                )}

                {!isHost && !pictureReady && (
                  <div className="stage-empty">
                    <div className="spinner" />
                    <h3>{fileName ? "Waiting for the picture" : "Waiting for the host"}</h3>
                    <p>
                      {fileName
                        ? "The control channel is up. Video starts as soon as the host plays."
                        : "The picture appears as soon as they start the stream."}
                    </p>
                  </div>
                )}

                <div className="stage-badges">
                  <span className="tag badge-e2ee">
                    <LockIcon size={11} strokeWidth={2.5} />
                    E2EE
                  </span>
                  <span className="tag tag-overlay">
                    {offline
                      ? "no source · host gone"
                      : `${isHost ? "to" : "from"} peer · ${formatRate(ownSample.kbps)}`}
                  </span>
                </div>

                <div className="stage-sync">
                  <span
                    className="tag tag-overlay"
                    style={{
                      color: offline
                        ? "var(--color-accent-400)"
                        : mode === "sync"
                          ? "#f4f4f5"
                          : "var(--color-accent-300)",
                    }}
                  >
                    <span className="sync-dot" />
                    {offline ? "no source" : mode === "sync" ? "synced to host" : "free seek"}
                  </span>
                </div>

                {offline && (
                  <div className="stage-overlay">
                    <div className="spinner" />
                    <h3>Host disconnected</h3>
                    <p>
                      Every frame comes from the host&apos;s device and nothing is cached on a
                      server, so playback stops here. Reconnecting for {countdown}s — after
                      that the session and its keys are gone.
                    </p>
                  </div>
                )}

                {needsGesture && !offline && (
                  <div className="stage-overlay">
                    <h3>Tap to start</h3>
                    <p>
                      Your browser blocks sound until you ask for it. Nothing streams before you
                      do.
                    </p>
                    <button type="button" className="btn btn-primary" onClick={startPlayback}>
                      <PlayIcon size={15} />
                      Start playback
                    </button>
                  </div>
                )}

                {activeSubtitle && (
                  <div className="subtitle-layer" aria-live="off">
                    <span>{activeSubtitle}</span>
                  </div>
                )}

                {qualityOpen && (
                  <div className="player-menu quality-menu" role="menu">
                    <span className="lbl">Quality</span>
                    {QUALITY_LADDER.map((rung) => (
                      <button
                        key={rung.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={quality === rung.id}
                        className="quality-opt"
                        onClick={() => chooseQuality(rung.id)}
                      >
                        <span>{rung.label}</span>
                        <span className="rate">{rung.note}</span>
                      </button>
                    ))}
                    <span className="quality-foot">
                      {formatRate(ownSample.kbps)} · {Math.round(ownSample.loss)}% loss ·{" "}
                      {Math.round(ownSample.rtt)} ms
                    </span>
                  </div>
                )}

                {speedOpen && (
                  <div className="player-menu speed-menu" role="menu">
                    <span className="lbl">Playback speed</span>
                    {PLAYBACK_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        role="menuitemradio"
                        aria-checked={playbackRate === rate}
                        className="quality-opt"
                        onClick={() => choosePlaybackRate(rate)}
                      >
                        <span>{rate}×</span>
                        {rate === 1 && <span className="rate">normal</span>}
                      </button>
                    ))}
                  </div>
                )}

                <div
                  className="controls"
                  inert={isFullscreen && !controlsVisible ? true : undefined}
                  aria-hidden={isFullscreen && !controlsVisible}
                >
                  {weakLink && (
                    <div className="weak-banner">
                      <span className="weak-dot" />
                      <span>
                        Link dropped to {formatRate(ownSample.kbps)} — WebRTC is stepping the
                        picture down
                      </span>
                    </div>
                  )}
                  <div
                    className="scrub"
                    role="slider"
                    tabIndex={0}
                    aria-label="Video position"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(duration)}
                    aria-valuenow={Math.round(position)}
                    aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
                    aria-disabled={!canSeek || offline}
                    onPointerDown={(event) => {
                      if (!canSeek || offline) return;
                      onScrubPointer(event);
                    }}
                    onKeyDown={onScrubKey}
                  >
                    <div className="scrub-track">
                      <div className="scrub-buffer" style={{ width: `${bufferPct}%` }} />
                      <div className="scrub-played" style={{ width: `${playedPct}%` }} />
                      <div className="scrub-head" style={{ left: `${playedPct}%` }} />
                    </div>
                  </div>
                  <div className="control-row">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={togglePlay}
                      disabled={offline}
                      title={playing ? "Pause (space)" : "Play (space)"}
                      aria-label={playing ? "Pause" : "Play"}
                    >
                      {playing ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <span className="timecode" aria-label={`${formatTime(position)} of ${formatTime(duration)}`}>
                      <span>{formatTime(position)}</span>
                      <span className="time-total"> / {formatTime(duration)}</span>
                    </span>

                    <div className="volume">
                      <button
                        type="button"
                        className="icon-btn icon-btn-dim"
                        onClick={toggleMute}
                        disabled={hostSilencedMe}
                        title={
                          hostSilencedMe
                            ? "The host has muted you"
                            : muted
                              ? "Unmute (m)"
                              : "Mute (m)"
                        }
                        aria-label={muted ? "Unmute" : "Mute"}
                      >
                        {muted ? <VolumeOffIcon /> : <VolumeIcon level={volume} />}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.02}
                        value={muted ? 0 : volume}
                        disabled={hostSilencedMe}
                        onChange={(event) => changeVolume(Number(event.target.value))}
                        aria-label="Volume"
                        title="Volume"
                        style={
                          {
                            "--vol": `${(muted ? 0 : volume) * 100}%`,
                          } as CSSProperties
                        }
                      />
                    </div>

                    <div className="nav-spacer" />
                    {hostSilencedMe && <span className="lbl control-owner">muted by host</span>}
                    <span className={`lbl control-owner${holderName ? " is-held" : ""}`}>
                      {controlLabel}
                    </span>
                    <button
                      type="button"
                      className="btn btn-overlay control-select"
                      onClick={() => {
                        setSpeedOpen(false);
                        setQualityOpen((open) => !open);
                      }}
                      aria-expanded={qualityOpen}
                      aria-label={`Quality: ${qualityButtonLabel}`}
                    >
                      {qualityButtonLabel}
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className="btn btn-overlay control-select speed-trigger"
                      onClick={() => {
                        if (!iHoldControl) {
                          notify("Playback speed follows the host in this session");
                          return;
                        }
                        setQualityOpen(false);
                        setSpeedOpen((open) => !open);
                      }}
                      aria-expanded={speedOpen}
                      aria-label={`Playback speed: ${playbackRate} times`}
                      title={iHoldControl ? "Playback speed" : "Playback speed follows the host"}
                    >
                      {playbackRate}×
                      <ChevronDownIcon />
                    </button>
                    <button
                      type="button"
                      className={`icon-btn cc-btn${subtitlesOn ? " is-active" : ""}`}
                      onClick={() => void toggleSubtitles()}
                      aria-label={
                        subtitleCues.length
                          ? subtitlesOn
                            ? "Turn subtitles off"
                            : "Turn subtitles on"
                          : isHost
                            ? "Add subtitles"
                            : "Subtitles unavailable"
                      }
                      aria-pressed={subtitlesOn}
                      title={subtitleName || (isHost ? "Add subtitles" : "No subtitles")}
                    >
                      CC
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn-dim"
                      onClick={toggleFullscreen}
                      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                      title={isFullscreen ? "Exit fullscreen (f)" : "Fullscreen (f)"}
                    >
                      <ExpandIcon />
                    </button>
                  </div>
                </div>
              </div>

              <div className="room-under">
                <div className="room-title-row">
                  <h4>{fileName || "Waiting for the host"}</h4>
                  <span className="mono lbl">{roomMeta}</span>
                </div>
                {isHost ? (
                  <div className="btn-row">
                    <button
                      type="button"
                      className={`btn ${mode === "sync" ? "btn-primary" : "btn-secondary"}`}
                      onClick={toggleSyncLock}
                    >
                      <LockIcon />
                      {mode === "sync" ? "Sync locked to me" : "Free seek allowed"}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={muteEveryone}>
                      Mute all viewers
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Change video
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => subtitleInputRef.current?.click()}
                    >
                      {subtitleName ? "Replace subtitles" : "Add subtitles"}
                    </button>
                    <button type="button" className="btn btn-danger" onClick={endSession}>
                      End session
                    </button>
                  </div>
                ) : (
                  <div className="btn-row">
                    <button
                      type="button"
                      className={`btn ${myPermissions.playPause ? "btn-primary" : "btn-secondary"}`}
                      onClick={requestControl}
                      disabled={myPermissions.playPause || pleaSent}
                    >
                      {myPermissions.playPause
                        ? "You have control"
                        : pleaSent
                          ? "Request sent…"
                          : "Request playback control"}
                    </button>
                    <button type="button" className="btn btn-danger" onClick={endSession}>
                      Leave
                    </button>
                    <span className="viewer-hint">
                      {mode === "sync"
                        ? "The host is driving playback — you stay in sync automatically."
                        : "Free seek is on: scrub without affecting anyone else."}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <aside className="rail">
              <div className="rail-tabs">
                <div className="seg seg-fill" role="tablist" aria-label="Session panels">
                  {PANEL_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      className="seg-opt"
                      aria-selected={panel === tab.id}
                      onClick={() => setPanel(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rail-body">
                {panel === "people" && (
                  <div>
                    <div className="panel-head">
                      <span className="lbl">In session · {participants.length}</span>
                      <span className="lbl">5 seats</span>
                    </div>

                    {host && (
                      <div className="peer peer-self">
                        <span className="peer-avatar is-host">
                          {host.id === session.peerId ? "YOU" : initialsOf(host.name)}
                        </span>
                        <div className="peer-id">
                          <span className="peer-name">
                            {host.id === session.peerId ? "You (host)" : host.name}
                          </span>
                          <span className="peer-stat">
                            source · {isHost ? "uplink" : "downlink"}{" "}
                            {formatRate(ownSample.kbps)}
                          </span>
                        </div>
                        <span className="tag tag-accent">HOST</span>
                      </div>
                    )}

                    {viewers.map((viewer) => {
                      const readout = peerReadouts[viewer.id];
                      const isSelf = viewer.id === session.peerId;
                      const holds = controlHolder === viewer.id;
                      const muted = mutedPeers.includes(viewer.id);
                      const warn = Boolean(
                        readout && (readout.rtt > 180 || readout.loss > WEAK_LOSS),
                      );
                      const stat = isSelf
                        ? `${rungForHeight(ownSample.height) || "connecting"} · ${Math.round(ownSample.rtt)}ms`
                        : readout
                          ? `${rungForHeight(readout.height) || "connecting"} · ${readout.rtt}ms${muted ? " · muted" : ""}${holds ? " · control" : ""}`
                          : "negotiating…";
                      return (
                        <div className="peer" key={viewer.id}>
                          <span className="peer-avatar">
                            {isSelf ? "YOU" : initialsOf(viewer.name)}
                          </span>
                          <div className="peer-id">
                            <span className="peer-name">
                              {viewer.name}
                              {isSelf ? " (you)" : ""}
                            </span>
                            <span className={`peer-stat${warn ? " is-warn" : ""}`}>{stat}</span>
                          </div>
                          {isHost && !isSelf && (
                            <div className="peer-actions">
                              <button
                                type="button"
                                className="btn peer-action"
                                aria-pressed={holds}
                                title="Give playback control"
                                onClick={() => toggleViewerControl(viewer.id, viewer.name)}
                              >
                                <ControlIcon />
                              </button>
                              <button
                                type="button"
                                className="btn peer-action is-mute"
                                aria-pressed={muted}
                                onClick={() => muteViewer(viewer.id, !muted)}
                              >
                                {muted ? "Unmute" : "Mute"}
                              </button>
                              <button
                                type="button"
                                className="btn peer-action is-remove"
                                title="Remove"
                                onClick={() => removeViewer(viewer.id, viewer.name)}
                              >
                                <CloseIcon size={13} />
                              </button>
                            </div>
                          )}
                          {!isHost && holds && <span className="tag tag-outline">CONTROL</span>}
                        </div>
                      );
                    })}

                    {pendingControl && isHost && (
                      <div className="pending">
                        <span>{pendingControl.name} wants playback control</span>
                        <div className="btn-row">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => resolvePending(true)}
                          >
                            Allow
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => resolvePending(false)}
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {panel === "share" && (
                  <div className="rail-pad">
                    <div className="seg seg-fill" role="tablist" aria-label="Invite format">
                      {CODE_TABS.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          className="seg-opt"
                          aria-selected={codeFormat === tab.id}
                          onClick={() => setCodeFormat(tab.id)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>
                    {qr && (
                      <div className="qr" style={{ alignSelf: "flex-start" }}>
                        <svg
                          viewBox={`0 0 ${qr.size} ${qr.size}`}
                          role="img"
                          aria-label="Invite QR code"
                        >
                          <path d={qr.path} fill="#0d0d0f" />
                        </svg>
                      </div>
                    )}
                    <div style={{ padding: "var(--space-3)", background: "var(--color-surface)" }}>
                      <span
                        className="code-value"
                        style={{ fontSize: 17, letterSpacing: "0.06em" }}
                      >
                        {codeText}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      onClick={copyCode}
                    >
                      Copy invite
                    </button>
                    <span style={{ fontSize: 12, color: "var(--dim)" }}>
                      Anyone holding the link can join while the session is live. Rotating issues
                      a new room and key: everyone connected right now moves across, and nobody
                      else can use the old invite.
                    </span>
                    {isHost && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-block"
                        onClick={rotateInvite}
                        disabled={busy}
                      >
                        Rotate invite
                      </button>
                    )}
                  </div>
                )}

                {panel === "trust" && (
                  <div>
                    <div className="trust-head">
                      <LockIcon strokeWidth={2.5} />
                      <span>AES-256-GCM CONTROL CHANNEL</span>
                    </div>
                    {trustTable}
                    <p className="trust-note">
                      The file never leaves the host&apos;s disk as a file. Frames are encoded on
                      the fly and sent peer to peer, encrypted in transit by WebRTC&apos;s
                      DTLS-SRTP; every room control on top of it is sealed with AES-256-GCM under
                      the invite key. The server only introduces peers — it stores no video, runs
                      no transcode, keeps no accounts or history. When the last peer leaves, the
                      room and its keys are gone.
                    </p>
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept={VIDEO_FILE_ACCEPT}
        onChange={onFileInput}
        aria-label="Choose a video file"
      />
      <input
        ref={subtitleInputRef}
        className="sr-only"
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={onSubtitleInput}
        aria-label="Choose an SRT or WebVTT subtitle file"
      />

      {privacyOpen && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => setPrivacyOpen(false)}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="What Relay never keeps"
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
              <span className="dialog-title">What we never keep</span>
              <button
                type="button"
                className="btn"
                onClick={() => setPrivacyOpen(false)}
                aria-label="Close"
                style={{ padding: 4, color: "var(--dim)" }}
              >
                <CloseIcon />
              </button>
            </div>
            {trustTable}
            <span className="dialog-body">
              Media is encrypted between the two devices by WebRTC and decrypted only inside a
              viewer&apos;s player. The signalling endpoint sees a room code and connection
              offers, never the invite key and never a frame of video.
            </span>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
