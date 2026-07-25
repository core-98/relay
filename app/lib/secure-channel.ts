import { base64UrlToBytes, bytesToBase64Url } from "./session-code";

export type Quality = "auto" | "1080" | "720" | "480" | "240";
export type PlaybackMode = "sync" | "independent";
export type PermissionKey = "playPause" | "seek" | "invite";
export type Permissions = Record<PermissionKey, boolean>;

export const NO_PERMISSIONS: Permissions = {
  playPause: false,
  seek: false,
  invite: false,
};

export const FULL_CONTROL: Permissions = {
  playPause: true,
  seek: true,
  invite: true,
};

/**
 * Everything that travels over the data channel is wrapped in AES-256-GCM
 * under the invite secret, on top of the DTLS the channel already provides.
 */
export type SecureMessage =
  | { type: "permission"; permissions: Permissions }
  | { type: "mode"; mode: PlaybackMode }
  | { type: "media"; name: string; duration: number; mode: PlaybackMode }
  | { type: "control"; action: "play" | "pause" | "seek"; value?: number }
  | { type: "control-request"; action: "play" | "pause" | "seek"; value?: number }
  | { type: "control-plea" }
  | { type: "control-plea-result"; granted: boolean }
  | { type: "holder"; name: string }
  // A live MediaStream carries no media timeline, so the host publishes the
  // position it is playing from and viewers render their scrubber off that.
  | { type: "position"; at: number; duration: number; playing: boolean }
  | { type: "quality"; quality: Quality }
  | { type: "mute"; muted: boolean }
  | { type: "stats"; kbps: number; rtt: number; height: number; loss: number }
  | { type: "rekey"; code: string; secret: string }
  | { type: "evicted" }
  | { type: "ended" }
  | { type: "notice"; message: string };

export async function importRoomKey(secret: string) {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(secret.trim());
  } catch {
    throw new Error("That invite key is not readable");
  }
  if (bytes.byteLength !== 32) throw new Error("That invite key is not a Relay key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptMessage(key: CryptoKey, message: SecureMessage) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cleartext = new TextEncoder().encode(JSON.stringify(message));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, cleartext);
  return JSON.stringify({
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

export async function decryptMessage(key: CryptoKey, envelope: string) {
  const parsed = JSON.parse(envelope) as { iv: string; data: string };
  const cleartext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(parsed.iv) },
    key,
    base64UrlToBytes(parsed.data),
  );
  return JSON.parse(new TextDecoder().decode(cleartext)) as SecureMessage;
}
