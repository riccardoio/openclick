---
name: add-todo
description: Add a checkbox-style task to Reminders for today.
---

# Add Todo to Reminders

## Goal
Open Reminders and add a new checkbox task to today's list.

## Steps
1. Launch Reminders (bundle id `com.apple.reminders`).
2. Snapshot the window. Locate the AXOutlineRow titled "Today" in the sidebar.
3. Click "Today".
4. Click the AXButton titled "+" or "New Reminder" in the toolbar.
5. Type the task text via type_text.
6. Press Return to commit.

## Anchors
- Sidebar entries are `AXOutlineRow` under `AXOutline`.
- The new-reminder button is `AXButton` in the main window's toolbar.

## Stop conditions
- A new row appears in Today's list with the typed text.
