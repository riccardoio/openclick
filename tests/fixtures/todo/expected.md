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
1. Open Reminders and focus today's list.
2. Create a new reminder row.
3. Type the task text and commit it.

## Anchors
- Sidebar entries are `AXOutlineRow` under `AXOutline`.
- The new-reminder button is `AXButton` in the main window's toolbar.
- The task title field is an `AXTextField` once a row is created.

## Stop conditions
- A new row appears in Today's list with the typed text.
