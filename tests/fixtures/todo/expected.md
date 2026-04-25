---
name: add-todo
description: Add a checkbox-style task to Reminders for today.
target:
  bundle_id: com.apple.reminders
  app_name: Reminders
keyboard_addressable: true
intent:
  goal: Add a new checkbox task to today's Reminders list.
  subgoals:
    - Focus today's list
    - Create a new reminder row
    - Type the task and commit
  success_signals:
    - A new row appears in Today's list with the typed text.
  observed_input_modes:
    - click
    - type_text
    - press_key
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
