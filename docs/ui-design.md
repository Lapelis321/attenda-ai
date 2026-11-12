# Attenda AI — UI design specification

Updated 12 November 2026. This is an implementation brief, not evidence of a working interface.

## Main goal
An inexperienced waiter immediately understands the **single next action** without training on the application. English UI for the MVP. Novice-friendly, not patronizing.

## Product screens
- /waiter: mobile-first, primary screen.
- /admin: desktop-first demo control, camera view and setup.
- /order: optional editable transcript and simplified order draft, accessed from a take-order task.

## Palette and typography
- Canvas: #F5F7F8; card: #FFFFFF.
- Text: #17242B; secondary: #5D6E75.
- Primary action: #176B5B with white text.
- Attention: #FFF4D6 background and #8A5A00 text, only for genuine warning or tentative computer-vision suggestions.
- Borders: #DDE5E7; corners 16–20 px; system UI font; body ≥16px and headings 24–28px.
- At least 44 px touch targets (prefer 48), high contrast, visible keyboard focus and clear text labels.
- No fake interactive controls or empty navigation.

## Mobile screen design
Top: ATTENDA AI (left), Connected indicator (right).
Context: YOUR NEXT STEP.
Large task card:
  TASK 02
  TABLE 1
  Order ready
  Collect the food from the kitchen and deliver it to Table 1.
  Show steps [expandable disclosure]
  [Mark delivered] [prominent full-width CTA]
Bottom: 1 task waiting. If none: You're all caught up. Wait for your next task.

Expanded steps:
1. Check the table number.
2. Verify the prepared dishes and any instructions.
3. Bring the food to Table 1.
4. Tap Mark delivered after delivery.

The button records employee confirmation, not machine-confirmed delivery.

## Take-order task
Task card: TABLE 1 · Take order.
Description: Go to Table 1, greet the guests, and ask what they would like.
Primary CTA: Start order.
Secondary disclosure: Show steps — greet; ask; clarify anything unclear; ask an authorized colleague for allergen questions; read back; confirm.
Order screen: explicit Start recording / Stop recording with consent; editable transcript; detected spoken language if reliably available; parsed menu suggestions for pizza/pasta/water; manual edit; **Confirm draft**. Never say 'Sent to kitchen' because no real POS connection exists. 'Type instead' fallback required.

## Admin desktop layout
Header: ATTENDA AI | DEMO MODE
Left panel: camera/MP4 preview, suggested table boxes and provisional numbers, editable/drag-adjustable/add/remove table boxes.
Right panel: Table 1 selector; [Send take-order task]; [Simulate order ready]; [Reset demo].
Below: active tasks and event history, showing precise source labels: 'SIMULATED KITCHEN' or 'CAMERA SUGGESTION'. Display task state OPEN / IN PROGRESS / DONE.

Quick setup: choose camera/video → Suggest tables → Review/adjust → Start demo. Candidate detection may use dining-table boxes, but user can manually draw at least one table when detection fails. Table numbering is provisional (e.g. left-to-right). The camera cannot know actual restaurant table IDs.

## Responsive and resilience
- Test phone at 360px and desktop at 1280px.
- Shared server state across /waiter and /admin; simple polling acceptable.
- Mark Done is idempotent. Repeated polls do not recreate tasks.
- Offline/connection loss shows an explicit error and retry; never silently claim success.
- Camera, speech and remote tunnel are optional; core simulated task flow still runs without them.
- Protect admin controls before exposing a tunnel or public deployment.

## Demo sequence
Admin triggers Take order → waiter gets task → opens optional steps → enters/records pizza and pasta draft → waiter confirms draft → admin simulates kitchen Order ready → waiter gets delivery instruction → marks delivered → admin shows completed. Camera perception appears as a separately labeled capability, not proof of actual service.

## Release gate
First pass only when two browser clients share task state, phone UI is understandable, completion and reset work, and the demo repeats. Do not add speech/table auto-discovery until this passes.

Canonical plan: https://app.notion.com/p/4167a1f4b8b58180be50cc5a281fb707

## Research-backed interaction rules (12 November)

**Product distinction:** Toast already provides food-ready handheld notifications and Square provides editable floor plans. Attenda's demo differentiator is contextual task instructions and *suggested* low-friction table setup, not claiming that notifications or floor plans are novel.

Sources: [Toast KDS](https://pos.toasttab.com/hardware/kitchen-display-system), [Square floor plans](https://squareup.com/help/us/en/article/6427-building-your-floor-plan), [Nielsen Norman Group progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [WCAG target sizes](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum).

### Quality checklist (for every Codex UI change)

- At 360px width, one task and its primary action are visible without horizontal scrolling.
- A new user can find Table 1, understand what to do, reveal optional steps and complete the task with no explanation from us.
- Only one visually dominant primary action per waiter screen. Secondary actions must be lower emphasis and accurately labeled.
- Keep a consistent spacing rhythm (8/16/24/32px), 16px+ body text, 24–28px task title, 44px+ controls and visible focus.
- No decorative gradients, glassmorphism, fake analytics, unnecessary tabs, random emojis or controls whose actions are placeholders.
- A network/API failure displays a real error and offers retry instead of pretending success; a disconnected waiter must not mark task done locally without server acknowledgment.
- The admin is allowed more information but initially shows only: camera + editable tables, selected-table action buttons, queue/history.
- A first-run camera setup needs at most three named stages: choose source, review suggested table boxes/numbers, save and start. Add/rename/remove/manual draw remain discoverable.
- Clear event source chips: SIMULATED KITCHEN, CAMERA SUGGESTION, WAITER REPORTED. Do not use source badges as proof of actual service.
- No 'Order sent' for a transcript-only draft, no audio capture without a visible start/stop action and consent, no faux Android push notifications when the app only polls while open.
- The visual result should be checked against real screenshots on both desktop and Redmi Android phone, not inferred from CSS alone.

### User test with a helper (record observations, not invented results)

Ask a person who has not seen Attenda to open the waiter interface. Without instruction, observe whether they identify the table, read the action, expand help, and report completion. Note misunderstood labels, mis-taps and hesitation. Do not claim training-time or error-rate reduction without measurement.
