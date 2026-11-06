# Timeline playback smoothness — beta build fix

**What was wrong:** beta's failed build (run r_30f6a7aa50bb) was not a code error. The message was "This studio is out of credits: playtest.run needs 6 and 1 is left". The playtest could not run because the studio's balance was too low. The playback change from #123 (`player.js` `pacingStats`/`playbackStats`, the `playback4` and `playback` scenarios in `dashboard/gen/playtest.js`) typechecks and is on beta unchanged.

**What I changed:** no source change. Credits can't be fixed from code. I wrote `.hawkes/scenario.txt` (`playback4`) so beta's playtest plays the 4-track scenario.

**What J needs to do:** top up the studio's credits (Settings → Plan and credits, 6+ for a playtest.run), then re-run beta's playtest.

**Criteria:** `playback4` plays a 4-track timeline for 30 s and reports `p5 fps` (above 45 expected). It then seeks with real keys and reports `seekResumeMs` (under 300 expected).

**Not done:** there is no browser here, so I could not measure fps. The before/after fps table for the PR has to come from the `playback4` run on beta: "before" is the earlier playtest run, "after" is the run once credits are back.

**GPU:** none used, so there is no estimate to give.
