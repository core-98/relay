/**
 * Reading an invite QR off the camera.
 *
 * Chromium exposes the Shape Detection API, which decodes on a native thread
 * for free. WebKit does not, and every browser on iOS is WebKit — so an
 * installed iOS PWA would otherwise have no scanner at all. The fallback pulls
 * frames onto a canvas and decodes them with jsQR, loaded only when the camera
 * actually opens.
 */

/** The longest edge handed to the JS decoder. Full sensor frames are wasted work. */
const DECODE_EDGE = 640;

type DetectedBarcode = { rawValue: string };

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
};

type BarcodeDetectorCtor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
};

/** Resolves to the QR text in the frame, or null when there is nothing to read. */
export type QrFrameReader = (video: HTMLVideoElement) => Promise<string | null>;

export function cameraScanSupported() {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    window.isSecureContext
  );
}

async function nativeReader(): Promise<QrFrameReader | null> {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    const formats = (await ctor.getSupportedFormats?.()) ?? ["qr_code"];
    if (!formats.includes("qr_code")) return null;
    const detector = new ctor({ formats: ["qr_code"] });
    return async (video) => {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue?.trim() || null;
    };
  } catch {
    // Some builds advertise the constructor and then throw on first use.
    return null;
  }
}

async function canvasReader(): Promise<QrFrameReader> {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot read camera frames");

  return async (video) => {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return null;

    const scale = Math.min(1, DECODE_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.drawImage(video, 0, 0, width, height);
    const frame = context.getImageData(0, 0, width, height);
    // A QR on a screen or on paper is never inverted, and skipping the second
    // pass halves the work on the slowest devices.
    const result = jsQR(frame.data, width, height, { inversionAttempts: "dontInvert" });
    return result?.data.trim() || null;
  };
}

export async function createQrReader(): Promise<QrFrameReader> {
  return (await nativeReader()) ?? (await canvasReader());
}

/** Turns a getUserMedia rejection into something worth putting on screen. */
export function cameraErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow the camera for this site, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera on this device — type the code instead.";
  }
  if (name === "NotReadableError") {
    return "The camera is busy in another app. Close it and try again.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not open the camera.";
}
