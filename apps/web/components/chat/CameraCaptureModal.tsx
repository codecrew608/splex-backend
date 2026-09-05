"use client";

import { useEffect, useRef, useState } from "react";
import { X, Camera as CameraIcon, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface CameraCaptureModalProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

// Mirrors describeVoiceError's own style/tone in Composer.tsx — same
// "ask for the specific permission, name the specific fix" convention
// already established there for the microphone.
function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Camera access is blocked. Allow it in your browser's site settings and try again.";
    case "NotFoundError":
      return "No camera found. Check that one is connected and try again.";
    case "NotReadableError":
      return "Couldn't access the camera — it may already be in use by another app.";
    default:
      return "Couldn't start the camera. Please try again.";
  }
}

const JPEG_QUALITY = 0.92;

export function CameraCaptureModal({ onCapture, onClose }: CameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The frozen still, shown in place of the live feed until the user
  // decides to keep it or retake — capturedUrl is an object URL for
  // <img>, capturedBlob is what actually gets attached on "Use photo".
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const capturedBlobRef = useRef<Blob | null>(null);

  // Runs once — stopStream is called from every exit path below
  // (Cancel, Use photo, Retake's own restart, and unmount), never left to
  // the browser's own garbage collection: an un-stopped track keeps the
  // camera hardware (and the OS's own "camera in use" indicator) live
  // even after this modal is gone.
  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        if (!cancelled) setError(describeCameraError(err));
      }
    }

    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once; capturedUrl is read fresh via the closure at cleanup time
  }, []);

  function handleCapture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        capturedBlobRef.current = blob;
        setCapturedUrl(URL.createObjectURL(blob));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  }

  function handleRetake() {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedUrl(null);
    capturedBlobRef.current = null;
  }

  function handleUsePhoto() {
    const blob = capturedBlobRef.current;
    if (!blob) return;
    onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }));
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onClose();
  }

  function handleClose() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-raised"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium text-foreground">Take a photo</span>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close camera"
            title="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>

        <div className="relative aspect-[4/3] w-full bg-black">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white/80">{error}</div>
          ) : capturedUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a freshly captured local blob, not a static/optimizable asset
            <img src={capturedUrl} alt="Captured preview" className="h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- a live device camera feed, no captions apply
            <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
          )}
        </div>

        <div className="flex items-center justify-center gap-3 px-4 py-3.5">
          {error ? (
            <Button variant="secondary" onClick={handleClose}>
              Close
            </Button>
          ) : capturedUrl ? (
            <>
              <Button variant="secondary" onClick={handleRetake}>
                <RotateCcw size={14} strokeWidth={1.8} />
                Retake
              </Button>
              <Button onClick={handleUsePhoto}>Use photo</Button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleCapture}
              aria-label="Capture photo"
              title="Capture"
              className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-white/70 bg-white/20 transition-colors hover:bg-white/30"
            >
              <CameraIcon size={22} strokeWidth={1.8} className="text-white" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
