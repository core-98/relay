/**
 * Room codes come in three interchangeable renderings:
 *
 *   numeric  472913              — the canonical room id
 *   words    larch-crystal-cedar — the same 20 bits, base-100 against WORDS
 *   link     https://…/?room=472913#key=…  — the id plus the 256-bit invite key
 *
 * Numeric and word codes address a room; they are not key material. Only the
 * link carries the secret, and it lives in the fragment, which browsers never
 * send to a server.
 */

const WORDS = [
  "amber", "anchor", "arbor", "aspen", "atlas", "aurora", "basil", "beacon", "birch", "bison",
  "bloom", "brass", "breeze", "bronze", "cactus", "canyon", "cedar", "cinder", "cobalt", "comet",
  "coral", "cotton", "crane", "crest", "crystal", "dahlia", "delta", "dune", "ember", "falcon",
  "fern", "fjord", "flint", "forest", "garnet", "glacier", "granite", "harbor", "hazel", "heron",
  "indigo", "ivory", "jade", "juniper", "kelp", "lagoon", "lantern", "larch", "lilac", "linen",
  "lotus", "lumen", "maple", "marble", "meadow", "mesa", "mica", "mint", "monsoon", "moss",
  "nectar", "nimbus", "oasis", "ochre", "olive", "onyx", "opal", "orchid", "otter", "pebble",
  "pepper", "pewter", "pine", "plateau", "pollen", "poppy", "prairie", "quartz", "quill", "raven",
  "reef", "ridge", "river", "rowan", "saffron", "sage", "sandal", "sequoia", "shale", "silver",
  "slate", "sorrel", "spruce", "summit", "thistle", "topaz", "tundra", "umber", "willow", "zinnia",
];

export type CodeFormat = "numeric" | "words" | "link";

export const CODE_LENGTH = 6;

/** A uniform six-digit code. Rejection sampling keeps the modulo bias out. */
export function makeRoomCode() {
  const limit = 1_000_000;
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= ceiling);
  return String(value % limit).padStart(CODE_LENGTH, "0");
}

export function makeSecret() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function isRoomCode(value: string) {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value);
}

/** "472913" → "472 913" */
export function formatRoomCode(code: string) {
  return isRoomCode(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** "472913" → "larch-crystal-cedar" */
export function wordsFromCode(code: string) {
  if (!isRoomCode(code)) return "";
  return [0, 2, 4]
    .map((offset) => WORDS[Number(code.slice(offset, offset + 2))])
    .join("-");
}

/** "larch crystal cedar" → "472913", or "" when a word is not in the list. */
export function codeFromWords(phrase: string) {
  const parts = phrase.trim().toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (parts.length !== 3) return "";
  const indexes = parts.map((word) => WORDS.indexOf(word));
  if (indexes.some((index) => index < 0)) return "";
  return indexes.map((index) => String(index).padStart(2, "0")).join("");
}

export function inviteUrl(origin: string, code: string, secret: string) {
  return `${origin}/?room=${code}#key=${secret}`;
}

/**
 * Reads whatever the joiner pasted: a bare code, a word phrase, or a full
 * invite link. `secret` is only present when the input carried one.
 */
export function parseInvite(input: string): { code: string; secret: string } {
  const trimmed = input.trim();
  if (!trimmed) return { code: "", secret: "" };

  if (/[?#]/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed)) {
    const room = /[?&]room=([^&#\s]+)/i.exec(trimmed);
    const key = /[#&]key=([^&\s]+)/i.exec(trimmed);
    const code = decodeURIComponent(room?.[1] ?? "").replace(/\D/g, "");
    return {
      code: isRoomCode(code) ? code : "",
      secret: decodeURIComponent(key?.[1] ?? ""),
    };
  }

  const digits = trimmed.replace(/\D/g, "");
  if (isRoomCode(digits)) return { code: digits, secret: "" };
  return { code: codeFromWords(trimmed), secret: "" };
}

export function renderCode(
  format: CodeFormat,
  code: string,
  secret: string,
  origin: string,
) {
  if (format === "words") return wordsFromCode(code);
  if (format === "link") return inviteUrl(origin, code, secret);
  return formatRoomCode(code);
}
