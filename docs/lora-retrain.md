# Proposal: retrain the character LoRAs (stronger, per-image captions)

**Status: waiting for J** (it costs GPU money). Nothing below has run yet.

## Why

The two LoRAs we have (`susan`, `exit-punk`, trained 2026-10-16) keep the outfit roughly but drift on face, proportions
and signature items. Their training was weak on every axis that matters:

| | Now | Proposed |
|---|---|---|
| Images | 9 (source + a few poses) | 20–25: the source image, the 9 poses, 8 `image.angles` views of the source (front, 3/4, side, back, close-up), 4–6 frames from their best clips |
| Captions | one caption for all 9 | one per image (`lora.train` v3 `autoCaption`: Claude writes what changes per image, never the character's own look, so the look binds to the trigger word) |
| Steps / rank | 900 / 16 | 2,000 / 32 (100 per image is the usual floor; rank 32 holds more detail) |
| Resolution | 768 | 768 (1024 doesn't fit the L40S, measured) |
| Check | by eye | 8 fixed test prompts per character through `image.character`, old vs new LoRA, scored on-model by Claude vision against the source image |

## Cost (from the real jobs)

The current trainings took 2,507–2,532 GPU-seconds for 900 steps (about 2.8 s a step with loading and preparation).

| | GPU | Dollars |
|---|---|---|
| Dataset per character (`image.angles` 8 views, captions) | ~2 min | ~$0.10 |
| Training per character (2,000 steps) | ~1.5 h | ~$2.80 |
| Test images per character (8 × old + new) | ~2 min | ~$0.05 |
| **Pilot: Susan + Exit Punk** | **~3.1 h** | **~$6** (+ ~$0.12 boot) |
| All 33 characters (after a good pilot) | ~100 h, ~25 h on 4 servers | ~$97 |

Plus the disks already paid for. Stop the servers when the batch ends (the idle tail is $1.86 per server-hour).

## Plan

1. Pilot (J's OK, ~$6): build the datasets for Susan and Exit Punk, train both with the settings above, run the test
   prompts with the old and the new LoRA, and show J a side-by-side sheet with Claude's on-model scores.
2. If the new ones win clearly: keep the settings as `lora.train` defaults, then retrain the rest in batches of 4
   (one per server; J approves each batch's estimate from `POST /v1/estimate`).
3. Content agents use `image.character` with the new LoRAs for poses and keyframes that `image.edit` drifts on
   (DoD fighters, story keyframes), and list the LoRA in their asset recipes so a retrain marks those assets out of date.

## Untested

`lora.train` v3's per-image captions load through ComfyUI's `LoadImageTextDataSetFromFolder` (an image + `.txt`
folder in the server's input directory). The node schema matches; it has not run on a server yet, so the pilot is also
its first live run.
