---
name: triage-issues
description: Triage open issues in a public GitHub repo by applying labels and closing duplicates.
target:
  bundle_id: com.google.Chrome
  app_name: Google Chrome
keyboard_addressable: true
---

# Triage GitHub Issues

## Goal
For each open issue in the repo's issues page, read the title and body, decide a label
(bug / enhancement / question), and apply it. If the issue duplicates an earlier one,
close as duplicate.

## Steps
1. Open Chrome to `https://github.com/<repo>/issues?q=is:issue+is:open` via launch_app.
2. Snapshot the window state. The issue list is an AXList with AXLink children.
3. For each unread issue in the list:
   1. Click the issue link.
   2. Snapshot to read the title and body.
   3. Decide a label: "bug" if reporting broken behavior, "enhancement" if requesting
      new behavior, "question" if asking how something works.
   4. Click the AXButton titled "Labels" in the right sidebar.
   5. Click the matching label in the popover.
   6. Click outside the popover to dismiss.
   7. If the body matches an earlier issue's intent, click "Close issue" with
      reason "duplicate".
   8. Hotkey cmd+[ to return to the list.
4. Stop when no unread issues remain.

## Anchors
- Labels button is `AXButton[title=Labels]` in the right toolbar.
- Issue list items are `AXLink` under `AXList` in the main content area.

## Stop conditions
- All visible issues have a label.
- A modal the skill doesn't recognize appears.
