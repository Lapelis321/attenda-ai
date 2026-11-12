# Attenda

**Every table deserves attention.**

Attenda is a camera-based restaurant service assistant developed for **Unfair Weekend 2026**. Its MVP aims to detect people in defined table zones, track how long a table has been occupied, and flag tables that may need staff attention.

## MVP scope

- One consented camera feed or video file
- One or two configurable table zones
- Pretrained person detection (YOLO11n)
- Occupancy timers and automatic attention alerts
- Simple live dashboard

Staff-approach inference is optional. An observed approach **does not establish that service was completed**.

## Planned stack

Python, Ultralytics YOLO11n, OpenCV and Streamlit. Dependencies and integration are not yet validated.

## Local setup

1. Clone the repository.
2. Create a Python virtual environment.
3. Install dependencies from `requirements.txt` (once validated).
4. Configure table polygons in `config/tables.json`.
5. Provide a consented local video or camera stream.

**Current status:** repository scaffolding only. Detection, alerting and dashboard functions are not yet implemented or tested.

## Privacy

Do not commit identifiable restaurant footage, credentials, local model weights or personal data. For demos, use consented footage and process it locally where feasible.

## Hackathon deliverables

Working prototype, public GitHub repository, demonstration video (maximum 3 minutes), and Devpost submission.
