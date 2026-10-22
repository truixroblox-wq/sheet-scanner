import { useCallback, useEffect, useRef, useState } from 'react';
import { frameSignature, meanDifference, videoFrameToCanvas } from '../lib/image';

const PERMISSION_MESSAGE =
  'Camera permission was denied. Allow camera access or upload an image instead.';

/**
 * Camera capture is only available in a secure context. Netlify serves the
 * production site over HTTPS; this explicit check gives a useful message when
 * the app is opened over plain HTTP (for example from a LAN address).
 */
function cameraContextError(): string | null {
  if (!window.isSecureContext) {
    return 'Camera access requires HTTPS. Open this site over HTTPS, or upload an image instead.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Camera access is not available in this browser. Use a modern browser over HTTPS, or upload an image instead.';
  }
  return null;
}

function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return PERMISSION_MESSAGE;
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device. Upload an image instead.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is already in use by another app. Close it and try again, or upload an image instead.';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'This camera does not support the requested video settings. Try another camera or upload an image instead.';
  }
  if (/permission|denied/i.test(message)) return PERMISSION_MESSAGE;
  return `Could not start the camera: ${message || 'unknown error'}`;
}

export function CameraPanel({
  onCapture,
  busy,
  autoCapture,
  onAutoCaptureChange,
}: {
  onCapture: (canvas: HTMLCanvasElement) => void;
  busy: boolean;
  autoCapture: boolean;
  onAutoCaptureChange: (value: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stableRef = useRef(0);
  const prevRef = useRef<Uint8ClampedArray | null>(null);
  const cooldownRef = useRef(0);
  const busyRef = useRef(busy);
  const autoRef = useRef(autoCapture);
  const onCaptureRef = useRef(onCapture);
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('Camera off');
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    autoRef.current = autoCapture;
  }, [autoCapture]);

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setOn(false);
    setStatus('Camera off');
    stableRef.current = 0;
    prevRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current || starting) return;

    const contextError = cameraContextError();
    if (contextError) {
      setError(contextError);
      setStatus('Camera unavailable');
      return;
    }

    setStarting(true);
    setError(null);
    setStatus('Starting camera…');
    try {
      const mediaDevices = navigator.mediaDevices;
      const stream = await mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setOn(true);
      setStatus('Hold the sheet steady');
    } catch (err) {
      stop();
      setError(cameraErrorMessage(err));
      setStatus('Camera unavailable');
    } finally {
      setStarting(false);
    }
  }, [starting, stop]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const canvas = videoFrameToCanvas(video);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 280);
    cooldownRef.current = performance.now() + 2600;
    stableRef.current = 0;
    onCaptureRef.current(canvas);
  }, []);

  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      if (busyRef.current) {
        setStatus('Scanning…');
        stableRef.current = 0;
        return;
      }
      if (performance.now() < cooldownRef.current) {
        setStatus('Ready for the next sheet');
        return;
      }
      const frame = document.createElement('canvas');
      frame.width = 320;
      frame.height = 240;
      const ctx = frame.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, frame.width, frame.height);
      const signature = frameSignature(frame);
      if (signature.edge < 7) {
        stableRef.current = 0;
        prevRef.current = signature.pixels;
        setStatus('Fill the frame with the answer table');
        return;
      }
      const diff = prevRef.current ? meanDifference(prevRef.current, signature.pixels) : 999;
      prevRef.current = signature.pixels;
      if (diff < 2.4) {
        stableRef.current += 1;
        setStatus(
          autoRef.current
            ? stableRef.current >= 5
              ? 'Capturing…'
              : 'Hold steady…'
            : 'Steady — tap Capture',
        );
        if (autoRef.current && stableRef.current >= 5) {
          capture();
        }
      } else {
        stableRef.current = 0;
        setStatus('Hold the sheet steady');
      }
    }, 220);
    return () => window.clearInterval(timer);
  }, [on, capture]);

  useEffect(() => stop, [stop]);

  return (
    <section className="card camera-card">
      <div className="camera-stage">
        <video ref={videoRef} playsInline muted />
        {!on && (
          <div className="camera-placeholder">
            <strong>Scan with the camera</strong>
            Point the rear camera at one complete answer table. Keep all four table edges inside
            the guide. Nothing leaves this device.
          </div>
        )}
        {on && <div className="camera-guide" aria-hidden />}
        {flash && <div className="flash" aria-hidden />}
      </div>
      <div className="camera-bar">
        {!on ? (
          <button className="btn btn-primary btn-lg" onClick={start} disabled={starting}>
            {starting ? 'Starting…' : 'Start camera'}
          </button>
        ) : (
          <>
            <button className="btn btn-primary btn-lg" onClick={capture} disabled={busy}>
              {busy ? 'Scanning…' : 'Capture'}
            </button>
            <button className="btn btn-ghost" onClick={stop}>
              Stop
            </button>
            <button
              className={`btn ${autoCapture ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => onAutoCaptureChange(!autoCapture)}
              aria-pressed={autoCapture}
            >
              Auto {autoCapture ? 'on' : 'off'}
            </button>
          </>
        )}
        <div className="camera-status">
          <span className="dot" style={{ color: on ? 'var(--good)' : 'var(--muted)' }} />
          {status}
        </div>
      </div>
      {error && (
        <div className="card-pad" style={{ paddingTop: 0 }}>
          <div className="error-box">{error}</div>
        </div>
      )}
    </section>
  );
}
