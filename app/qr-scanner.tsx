"use client";

import { useEffect, useRef, useState } from "react";

import { CloseIcon } from "./icons";
import { cameraErrorMessage, createQrReader } from "./lib/qr-scan";

/** Gap between decode attempts. Fast enough to feel instant, cheap on battery. */
const SCAN_INTERVAL = 140;
/** How long a "wrong QR" hint stays up before the viewfinder goes quiet again. */
const HINT_LIFETIME = 2600;

type Props = {
  /**
   * Handed every code the camera reads. Return true to accept it — the scanner
   * then stops and the caller is expected to close it. Returning false keeps
   * the camera running, so a stray QR in frame does not end the scan.
   */
  onResult: (text: string) => boolean;
  onClose: () => void;
};

export function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // The camera is started once; the callback must stay swappable without
  // tearing the stream down and asking for permission again.
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [hint, setHint] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer = 0;
    let hintTimer = 0;

    async function run() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser cannot open the camera — type the code instead.");
      }
      const opened = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      // Closing the sheet during the permission prompt runs the cleanup before
      // this resolves, so the late stream has to put itself away.
      if (stopped || !video) {
        opened.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = opened;

      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (stopped) return;
      setLive(true);

      const read = await createQrReader();
      if (stopped) return;

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          const text = await read(video).catch(() => null);
          if (stopped) return;
          if (text) {
            if (onResultRef.current(text)) {
              navigator.vibrate?.(24);
              return;
            }
            setHint("That QR is not a Relay invite.");
            window.clearTimeout(hintTimer);
            hintTimer = window.setTimeout(() => setHint(""), HINT_LIFETIME);
          }
        }
        timer = window.setTimeout(tick, SCAN_INTERVAL);
      };
      void tick();
    }

    run().catch((cameraError) => {
      if (!stopped) setError(cameraErrorMessage(cameraError));
    });

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(hintTimer);
      // The camera indicator must go out the moment the sheet closes, so the
      // tracks are stopped here rather than left to the element's teardown.
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, []);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog scan-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scan an invite QR code"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="scan-head">
          <span className="dialog-title">Scan the invite</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close scanner">
            <CloseIcon />
          </button>
        </div>

        {error ? (
          <div className="note note-alert" role="alert">
            <span>{error}</span>
          </div>
        ) : (
          <div className="scan-view">
            <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview" />
            <div className="scan-frame" aria-hidden="true" />
            {!live && <span className="scan-wait">Opening the camera…</span>}
          </div>
        )}

        <span className="lbl" role="status">
          {hint || "Point this at the host's QR code. The camera feed stays on this device."}
        </span>

        <button type="button" className="btn btn-secondary btn-block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
