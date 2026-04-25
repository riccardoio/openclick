---
name: triage-issues
description: Triage open issues in a GitHub repo by applying labels.
target:
  bundle_id: com.github.GitHubClient
  app_name: GitHub Desktop
keyboard_addressable: false
intent:
  goal: Apply a label to each open issue in a GitHub repo.
  subgoals:
    - Open the issues list
    - For each issue, decide a label
    - Apply the label
  success_signals:
    - All visible issues have a label.
  observed_input_modes:
    - click
---

# Triage GitHub Issues

## Goal
For each open issue, apply a label.

## Steps
1. Open the issues page.
2. For each issue, click Labels.
3. Apply the matching label.

## Stop conditions
- All visible issues have a label.
