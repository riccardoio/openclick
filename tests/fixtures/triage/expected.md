---
name: triage-issues
description: Triage open issues in a public GitHub repo by applying labels and closing duplicates.
target:
  bundle_id: com.google.Chrome
  app_name: Google Chrome
keyboard_addressable: true
intent:
  goal: Apply a label (and close-as-duplicate when applicable) to each open issue in a GitHub repo.
  subgoals:
    - Open the issues list
    - For each issue, read its title and body
    - Apply the appropriate label
    - Close as duplicate when the body matches an earlier issue
  success_signals:
    - All visible issues have a label.
  observed_input_modes:
    - click
    - hotkey
---

# Triage GitHub Issues

## Goal
For each open issue in the repo's issues page, read the title and body, decide a label
(bug / enhancement / question), and apply it. If the issue duplicates an earlier one,
close as duplicate.

## Steps
1. Open the issues list for the target repo.
2. For each unread issue, read its title and body and decide a label
   (bug / enhancement / question).
3. Apply the chosen label.
4. If the issue duplicates an earlier one, close it as a duplicate.
5. Return to the list and continue until no unread issues remain.

## Stop conditions
- All visible issues have a label.
- A modal the skill doesn't recognize appears.
