# Attenda AI — Your AI Waiter Copilot

**A first-time waiter gets a smartphone and a clear next step.**

Attenda AI is a solo MVP for Unfair Weekend 2026. It aims to guide inexperienced restaurant staff through table-service workflows using contextual tasks, camera-based observations and eventually integrations with restaurant systems. The product pitch is faster onboarding and more consistent service, **not** that AI replaces hospitality or required food-safety training.

## Approved hackathon MVP (pivot: 12 November 2026)

**First executable scenario**
1. Open a responsive **waiter task screen** and a **manager/demo panel** on separate devices or browser sessions.
2. The demo panel simulates **"Order ready — Table 1"** (no real kitchen integration).
3. The waiter sees **"Pick up the order and deliver it to Table 1."**
4. Waiter taps **Done**; both views reflect completion.
5. A second simulated event can direct the waiter to **take an order**.

**Support modules (in priority order)**
- Reuse the current OpenCV/YOLO11n person detector to observe occupied tables from one *consented* camera or MP4.
- Fast setup: select source, suggest possible table zones/numbers **if reliable**, and allow manual editing and one-table fallback.
- Desired explicit **press-to-transcribe** order capture with automatic spoken-language detection where tested, a reviewed editable transcript, simple pizza/pasta order-item suggestions and typed fallback. The demo interface is **English only**. Speech recognition and automatic language detection remain unverified until run on the target devices.
- Optional occupancy-derived **suggested** task; camera proximity cannot verify service or that an order was taken.

**Not in the hackathon MVP:** production POS/KDS integrations, real automated order submission, payments, facial recognition, employee identification, covert audio/video collection, multi-camera tracking or custom model training.

## Current verified status

- The repository contains a runnable person-detection *smoke test* in `app/detector.py` for authorized camera/video input; the user has visually confirmed detections in a local run.
- Waiter task app, manager-event simulator, table automation, transcription and integrated dashboard are **not yet verified as implemented**.
- Implementation is tracked in [M1 core app #2](https://github.com/Lapelis321/attenda-ai/issues/2), [M2 camera/table setup #3](https://github.com/Lapelis321/attenda-ai/issues/3), [M3 speech/order draft #4](https://github.com/Lapelis321/attenda-ai/issues/4), [the Notion execution plan](https://app.notion.com/p/4167a1f4b8b58180be50cc5a281fb707) and the [UI design specification](docs/ui-design.md).

## Existing local detection smoke test (Windows)

Use a virtual environment with the dependencies from `requirements.txt` and an existing local YOLO11n weights file in `~/DevEnvs/ModelCache/yolo11n.pt`.

```powershell
python -m app.detector --source "path/to/consented-video.mp4"
# or a camera index:
python -m app.detector --source 0
```

Press `q` in the video window to stop. This script draws person boxes only; it does not yet infer table service. Use the actual file path on your Windows machine.

## Technology and licensing

Python, OpenCV and pretrained Ultralytics YOLO11n are already used for detection. The responsive task web app has not been merged yet. Ultralytics software/weights have **AGPL-3.0 or enterprise licensing** implications: review licence obligations before redistributing or commercializing. No paid cloud inference dependency is assumed.

## Demo and privacy

Use explicitly consented staged footage and voice from participating people, not real patrons without authorization. Do not commit audio, identifiable footage, model weights, credentials or private data. Simulated kitchen events must be labeled as simulated. Human review is required before any order confirmation.

Required deliverables: working prototype, reviewer-accessible GitHub repository, demonstration video **maximum 3 minutes** and completed Devpost submission. Personal target: **14 November 2026 18:00 Europe/Vilnius**; official deadline **20:00**.
