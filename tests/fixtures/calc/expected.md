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
1. Open Calculator and bring its main window to the front.
2. Clear any pending state on the display.
3. Enter the expression 17 × 23.
4. Evaluate the expression.

## Stop conditions
- The result display reads "391".
- Any unrecognized modal appears.
