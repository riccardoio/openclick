---
name: calc
description: Use Calculator to compute 17 times 23.
target:
  bundle_id: com.apple.calculator
  app_name: Calculator
keyboard_addressable: true
intent:
  goal: Compute 17 × 23 in Calculator and leave the result on screen.
  inputs:
    a: 17
    b: 23
  subgoals:
    - Open Calculator
    - Enter the expression 17 × 23
    - Evaluate the expression
  success_signals:
    - The result display reads "391".
  observed_input_modes:
    - click
---

# Calculator: 17 × 23

## Goal
Open Calculator and compute 17 × 23.

## Steps
1. Launch Calculator (bundle id `com.apple.calculator`).
2. Click the AXButton titled "1".
3. Click the AXButton titled "7".
4. Click the AXButton titled "×" (multiply).
5. Click the AXButton titled "2".
6. Click the AXButton titled "3".
7. Click the AXButton titled "=" (equals).

## Anchors
- All number/operator buttons are AXButton inside Calculator's main window.

## Stop conditions
- The result display reads "391".
- Any unrecognized modal appears.
