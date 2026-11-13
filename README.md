# Attenda AI — M1 waiter workflow

Attenda AI M1 is a local Flask and SQLite demo for coordinating waiter tasks. A manager can create simulated delivery or take-order tasks, and the mobile waiter view receives them through foreground polling. It is a hackathon prototype, not a production restaurant system.

## What M1 implements

- Manager demo at `/admin` with Table 1 and Table 2, simulated order-ready events, take-order task creation, live task/history/event views, duplicate suppression and demo reset.
- Mobile waiter workflow at `/waiter` with connection state, deterministic recommendation, Up next preview, selectable All tasks queue, valid start/complete transitions and retryable errors.
- Typed order drafts with editable dish name, quantity and notes; SQLite persistence; explicit save, review and confirmation; editing invalidates confirmation; completion is blocked until the current draft is confirmed.
- Deterministic priority: delivery base 100, take-order base 80, plus one point per elapsed task minute. Ties use creation time and task ID.
- A separate `app/detector.py` person-detection smoke test retained for authorized local input. It is not integrated with M1 task creation.

M1 does not implement camera/table automation, speech recognition, transcription, kitchen/POS submission, payments, authentication or public deployment. All manager events are visibly simulated. Order confirmation records human review only.

Source documents: [M1 Issue #2](https://github.com/Lapelis321/attenda-ai/issues/2) and [UI design](docs/ui-design.md).

## Windows setup

Prerequisites: Python 3.10 or newer, Node.js/npm and Microsoft Edge.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm ci
```

No cloud service or API key is required. Do not commit `.env` files, runtime databases, recordings, private media or model weights.

## Start the application

```powershell
.\.venv\Scripts\Activate.ps1
python -m app.web
```

Open `http://127.0.0.1:5000/admin` and `http://127.0.0.1:5000/waiter` in separate browser sessions. Runtime state is stored in ignored `instance/attenda.sqlite3`. Reset clears demo tasks, drafts and history while preserving `config/tables.json`.

The development server binds only to `127.0.0.1`. Do not expose it through a tunnel or deploy it publicly: M1 admin and task APIs are unauthenticated, the reset confirmation phrase is an accidental-action guard rather than authentication, and the Flask development server is not production hardened.

## Run verification

Python regression suite:

```powershell
python -m pytest -q --basetemp=.pytest-m1 -p no:cacheprovider
```

Real Microsoft Edge suite at the configured 360×800 waiter and 1280×800 admin viewports:

```powershell
.\node_modules\.bin\playwright.cmd test --reporter=line
```

Playwright starts the local app automatically using `playwright.config.js`. The suite uses the installed Edge channel (`msedge`), separate manager/waiter browser contexts, real UI interactions and generated screenshots under ignored `qa/`.

Additional release checks:

```powershell
python -m compileall -q app tests
node --check app\static\waiter.js
node --check app\static\admin.js
node --check e2e\waiter-recovery.spec.js
python -m pip check
git diff --check
```

## Detector smoke test (not M1 integration)

With a local YOLO11n weights file and explicitly consented camera/video input:

```powershell
python -m app.detector --source "path\to\consented-video.mp4"
python -m app.detector --source 0
```

Press `q` to stop. This draws person boxes only; it does not infer occupancy, service completion or guest intent.

## Limitations, privacy and licensing

- Physical Android/device testing and a live two-device review still require human verification.
- Foreground polling is used; there are no push notifications or background guarantees.
- SQLite and the local Flask server are suitable for this demo, not multi-user production load.
- Use only consented staged media. Never use covert audio/video or infer allergens, modifications or quantities.
- Ultralytics software and weights have AGPL-3.0 or enterprise licensing implications. Review obligations before redistribution or commercial use.
- This repository currently has no project-level license file; no redistribution rights should be assumed.

M2 may integrate authorized camera/table setup. M3 may explore explicit press-to-transcribe input with human review. Neither capability is part of M1.
