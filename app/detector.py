"""Smoke test for person detection from a webcam or consented local video.

Run:
    python -m app.detector --source 0
    python -m app.detector --source path/to/consented-video.mp4

Press q to quit. This is NOT occupancy tracking or service detection.
"""
import argparse
import time
from pathlib import Path

import cv2
from ultralytics import YOLO

DEFAULT_MODEL = Path.home() / "DevEnvs" / "ModelCache" / "yolo11n.pt"


def main() -> None:
    parser = argparse.ArgumentParser(description="Test Attenda YOLO person detection")
    parser.add_argument("--source", default="0", help="Camera index or video file path")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--confidence", type=float, default=0.35)
    args = parser.parse_args()

    if not args.model.is_file():
        parser.error(f"Model not found: {args.model}")
    source = int(args.source) if args.source.isdigit() else args.source
    if isinstance(source, str) and not Path(source).is_file():
        parser.error(f"Video file not found: {source}")

    cap = cv2.VideoCapture(source, cv2.CAP_DSHOW) if isinstance(source, int) else cv2.VideoCapture(source)
    if not cap.isOpened():
        parser.error(f"Cannot open video source: {args.source}")

    model = YOLO(str(args.model))
    last_time = time.monotonic()
    processed = 0
    print("Press q in the video window to stop.")
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                print("Video ended or capture failed.")
                break

            result = model.predict(frame, classes=[0], conf=args.confidence, device="cpu", verbose=False)[0]
            count = len(result.boxes)
            annotated = result.plot()
            current = time.monotonic()
            fps = 1.0 / max(current - last_time, 1e-6)
            last_time = current
            cv2.putText(annotated, f"People detected: {count} | FPS: {fps:.1f}",
                        (15, 35), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
            cv2.imshow("Attenda - Person detection smoke test", annotated)
            processed += 1
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()
        print(f"Frames processed: {processed}")


if __name__ == "__main__":
    main()
