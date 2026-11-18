---
name: mock-schedule-batch
description: Create and sync batches of mock Athulya schedules in the attendance app, then verify imported schedule and call-queue status. Use when the user asks to generate mock schedules for testing.
---

# Create and sync mock schedules

Use the attendance app’s **Mock schedules** page to create fixtures and run the mock Athulya sync. Use browser UI automation (CUA) so the signed-in workspace and its current mode are visible and verifiable.

## Before creating

- Read the request for schedule date, first start time, number of schedules, interval, duration, and whether calls should actually be queued. Use Asia/Kolkata when the user is working in the Athulya workspace unless they specify another timezone.
- If a detail is omitted, use a reasonable mock default only when it cannot create an unexpected call. A five-minute duration is a useful default for short schedule fixtures. Confirm or ask when the choice changes who is called, whether calls are placed, or causes overlapping check-in/check-out jobs.
- Open **Settings → Athulya integration** and confirm **Test mode is active** before syncing. This ensures schedule sync and attendance submission use the mock Athulya server; it does not by itself make ChiefVoice telephony a mock.
- The mock schedule form is prefilled with synthetic patient/caregiver data. Inspect the caregiver phone before saving. Never substitute a real patient or staff contact unless the user specifically supplies and authorizes it for this test.
- The fixture form defaults to **Completed**, which imports the fixture without creating outbound call jobs. Use **Scheduled** only when the user intends to test call scheduling. Scheduled fixtures enqueue check-in and check-out calls through the configured ChiefVoice provider; tell the user before saving if that could dial a real number and their intent is unclear.

## Create the batch

1. In **Mock schedules**, add one fixture per requested schedule. Keep the same mock patient, caregiver, branch, and service unless the user requests variation.
2. Calculate each start from the requested first time and interval. For example, five starts at 10:35 AM with five-minute spacing are 10:35, 10:40, 10:45, 10:50, and 10:55 AM. Apply the chosen duration consistently.
3. Set the requested service date and status on every fixture. Check the displayed rows for the exact times and count before syncing.
4. In **Run Athulya sync**, select that same date and run **Sync this date** once. Wait for the run to finish; do not start another sync while one is running.

## Verify and report

- Confirm the sync ends as `succeeded`; report its received and saved/updated counts and note that they may include older fixtures as well as the new batch.
- Verify that the new schedule rows appear in **Attendance & schedules** or the imported schedule list.
- If calls were intended, check **Attendance calls → Scheduled retry queue** and report the check-in/check-out queue entries and their local times. The queue confirms calls are scheduled; it does not confirm that a call has already connected or completed.
- If the queue exposes adjacent check-out/check-in jobs at the same boundary time, point out the overlap. Do not silently change requested times to avoid it.
- If the app is unreachable, mock mode is off, a sync fails, or the phone destination is unclear, stop before retrying external actions and report the exact blocker.
- Never claim the sync or call queue succeeded until that state is visibly confirmed in the app.
