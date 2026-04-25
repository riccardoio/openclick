---
name: triage-issues
description: Triage open issues in a GitHub repo by applying labels.
target:
  bundle_id: com.github.GitHubClient
  app_name: GitHub Desktop
keyboard_addressable: false
---

# Triage GitHub Issues

## Goal
For each open issue, apply a label.

## Steps
1. Open the issues page.
2. For each issue, click Labels.
3. Apply the matching label.

## Anchors
- Labels button is `AXButton[title=Labels]`.

## Stop conditions
- All visible issues have a label.
