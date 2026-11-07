# Hawkes Gen: pre-public-launch test plan

*2026-11-07. Written from the code and AGENTS.md, and checked against the running beta (https://beta.hawkesgen.ai) where
it could be reached without signing in. Beta was on commit `eb95089` when checked, two merges behind `main` (it lacks
#136 phone pass and #138 prices up front), so rows for those say so.*

**How to read it.** One row per feature. **Cost**: *free* (no credits, no GPU), *mock* (runs on a mock or canned answer:
`HAWKESGEN_AI_MOCK`, `HAWKESGEN_AUDIO_MOCK`, `HAWKESGEN_QUALITY_MOCK`, Stripe test mode; no real spend), *paid* (spends
credits and real GPU or API money: price it first with `POST /v1/estimate`, J's OK before a batch). **Scenario**: the
`dashboard/gen/playtest.js` scenario that plays it (`smoke`, `media`, `signedout`, `createprice`, `guide`, `playback4`,
`progress`, `editing`, `library`, `aimock`, `phone`, `playback`), or *none* (manual or server test only). **Unconfirmed**
marks a claim not yet verified against code or the running beta.

**Setup for everything signed in.** Beta only: the test sign-in (`POST /v1/users/test-session`, secret set at
`PUT /v1/admin/test-signin`, `src/testsignin.ts`) gives a `playtest:<project>` account with starter credits. Real Google
sign-in needs a real browser and J's account. Passwords are off (410 `google_only`) unless `HAWKESGEN_PASSWORD_LOGIN=1`.

## Confirmed answers to the questions in the request

| Question | Answer | How confirmed |
|---|---|---|
| Does media delete exist? | **Not in the app.** The Media drawer and tiles have no Delete (`dashboard/gen/media.js`). `DELETE /v1/assets/:id` exists but needs role `admin` (`src/api.ts`, `requireRole(client, 'admin')`), so a customer cannot delete a file. Deleting a *scene* works (Scenes row menu, `DELETE /v1/scenes/:id`; "Files it made stay in Media"). | code |
| Do tags exist? | **API only.** Assets carry `tags`, `starred` and `title`, are searched by them (`src/library.ts` `listAssets` text filter, `updateAsset`), but no dashboard/gen module reads or writes tags. Media search matches them; people can't set them. | code (grep of `dashboard/gen`) |
| What do `/home`, `/app`, `/play` do? | Still served (`src/api.ts` ~373): `/home` (and `/public`) = `public/landing.html`, "Hawkes Play: Build Web Games with AI"; `/app` = `public/game-editor.html`, "Hawkes Play: Game Builder" (it posts to `/v1/games`, and its inline sign-in uses `/v1/users/login` and `/signup`, which are 410 with passwords off, so a signed-out visitor can't get in); `/play?game=<id>` = `public/player.html`, the game player. `public/app.html` ("Creator Studio") is no longer routed. All three answer HTTP 200 on beta. The product pages are *not* the Gen app and are not covered by any scenario. What each renders when used is **unconfirmed** (needs a browser). | code + `curl` on beta |
| What do the phone tabs offer? | Six bottom tabs (`dashboard/gen/index.html` `#mobileTabs`): **Edit** (center + timeline), **Media**, **Create**, **Scenes**, **Inspect** (relabelled by the scene in front: the stage's Shot panel, the character sheet…, `gen.js` `sceneActive`) and **AI**. The sheet sizes by dragging its grip. Page zoom is off (`nozoom.js`). | code |
| Is the analytics public route live? | **Yes on beta.** `POST /v1/analytics/collect` with `Origin: https://hawkesgen.ai` and an empty body answered **202** with the CORS headers for that origin; `GET /sdk/analytics@1.js` answers 200. Whether events are stored and queryable was not checked (needs a valid payload and an admin read): **unconfirmed**. Not seen on live (not tested). | `curl` on beta |
| Beta commit | `eb95089` (from `/v1/health`), lane `beta`, Claude on `max-plan`, `orgCredits: true`. | `curl` |

## 1. First visit, sign-in, accounts

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| L-01 | Landing (signed out) | `/`, `landing.js` | Signed out | Open `/` | Welcome with hero, three categories (Edit, Direct, Generate), strengths, Start free / Sign in; "Look around first" hides it for the visit | free | `signedout` |
| L-02 | Signed-out makes no calls | `gen.js`, `/v1/users/me` | Signed out | Open `/` and watch requests | Only `/v1/users/me` (and static files) is called | free | `signedout` |
| L-03 | Examples on the first screen | `landing.js` (#138) | Signed out; **beta lacks #138 until merged** | Open `/` | Examples show; a Sign in with Google button is visible | free | `signedout` |
| L-04 | Quick tour | `tour.js` | New account (`created`, or under 30 min old) | Sign in fresh | Three cards light Media, timeline and AI; Next, Back, Skip, arrows, Esc; shown once per account in this browser | free | none (the test account is reused: **unconfirmed** that a fresh one shows it) |
| L-05 | Guided first project | `guide.js` | Signed in, empty account | Pick an idea, a picture, play, dismiss | Steps advance; dismiss sticks | free | `guide` |
| L-06 | Help menu (?) | `gen.js`, `landing.js`, `tour.js` | Any | Open ?; choose each entry | Quick tour, Keyboard shortcuts (also `?` key), What Hawkes Gen does, Terms, Privacy, Contact all work | free | `editing` (shortcuts only) |
| L-07 | Legal pages | `/legal`, `/terms`, `/privacy`, `/refunds` | Any | Open each | All land on `legal.html` (200 on beta for `/legal`, `/terms`, `/refunds`) | free | none |
| L-08 | Google sign-in | `POST /v1/users/google`, `users.ts googleSignin`, `GET /v1/users/google` | Real Google account; origin listed in the Google client | Click Continue with Google | Account found by Google id, else by email (linked), else created with starter credits; cookie set | free | none (needs Google; the test sign-in stands in) |
| L-09 | Test sign-in | `POST /v1/users/test-session`, `/github` | Beta only, secret set | POST the token | Session cookie, `created` flag; 4xx on live | free | every scenario |
| L-10 | Passwords refused | `/v1/users/login`, `/signup` | Flag off | POST | 410 `google_only` | free | none |
| L-11 | Account menu and sheet | `account.js` | Signed in | Open the avatar menu, then the account sheet | Who, credits, Account and credits, Add credits, Admin (admins only), Help, Sign out last; sheet shows credits, packs and plans as cards, "Your AI" tucked away | free | none |
| L-12 | Sign out | `POST /v1/users/logout` | Signed in | Sign out | Landing returns; the cookie is gone | free | none |
| L-13 | Your AI (own Claude) | `account.js`, `/v1/users/me/ai/anthropic`, `/claude-subscription` | Signed in | Set, then clear, a key | Only "set" and the last 4 characters come back | free | none |
| L-14 | Disabled account | `user_flags`, admin Accounts | Admin | Disable an account | Its sessions and keys stop working; admins can't be disabled | free | none |

## 2. Credits, packs, plans, Stripe

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| B-01 | Starter credits | `users.ts` | New account | Sign in first time | Starter credits in the ledger | free | none |
| B-02 | Credits pill | `gen.js`, `lib.js` | Signed in | Spend until under 25 | Pill turns amber under 25 | free | none |
| B-03 | Packs and plans listed | `GET /v1/billing/packs`, `/v1/subscriptions/plans` | None | GET both | 200 (both answer on beta); plans seeded Creator $12 = 1,500, Pro $39 = 5,500 (provisional) | free | none |
| B-04 | Quote | `POST /v1/billing/quote`, `billing.ts` | Signed in | Quote a job | Credit price matches what Create shows | free | `createprice` |
| B-05 | Pack checkout | `POST /v1/billing/checkout` | Stripe test keys on beta | Buy a pack with a test card | Webhook adds credits once (`checkout.session.completed`) | mock (Stripe test mode) | none; **unconfirmed** that beta has test keys |
| B-06 | Subscription checkout | `POST /v1/subscriptions/checkout` | Stripe test keys | Subscribe | Credits granted once per paid invoice (`invoice:<id>` ledger key) | mock | none |
| B-07 | Cancel / resume / portal | `/v1/subscriptions/cancel`, `/resume`, `/v1/billing/portal` | Subscribed | Cancel, resume, open portal | Ends at month end; resumed; portal opens | mock | none |
| B-08 | Failed payment | webhook `invoice.payment_failed` | Test event | Send it | Plan `past_due`, still current | mock | none |
| B-09 | Webhook ignores other products | `billing.ts isGenEvent` | Shared Stripe account | Send a portal or Studio event | 200, nothing changes | mock | none |
| B-10 | Ledger | `GET /v1/billing/ledger` | Signed in | Spend, then read | Each charge listed; AI turns as `ai_turn`; admin notes visible without who | free | none |
| B-11 | Refund on failure | `jobs.ts`, `orgcredits.ts` | Charged job | Fail or cancel a job | Credits returned once | mock | `progress` (the failure display only) |
| B-12 | Out of credits | `lib.js friendly` | Balance 0 | Start a paid job | Plain "Add credits" message, no job queued | free | none |
| B-13 | Prices up front | `studio.js` (#138) | Signed in; **not on beta until merged** | Open every Create form | Credit price shown on open; changes with cost options | free | `createprice` |
| B-14 | Org credits (cells) | `src/orgcredits.ts` | Studio cell key | Submit with an `org_*` key | Charged in Studio's bank; 402 when out; fail closed 503 | mock | none (server test `test/orgcredits.test.ts`) |

## 3. Scene tabs

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| S-01 | Open scenes as tabs | `scenes.js`, `#sceneTabs` | Signed in | "+" then pick a kind | Tab opens; rename by double-click; reorder by drag; close; "all open scenes" button when crowded; remembered per browser | free | `smoke` |
| S-02 | Video scene | `editor.js` | Signed in | New Video | Tracks Text, Video (magnetic), Music, Voice, Sound | free | `smoke` |
| S-03 | Image scene | `editor.js` | Signed in | New Image | Tracks Top, Middle, Background; the frame at the playhead | free | none |
| S-04 | Audio scene | `editor.js` | Signed in | New Audio | Tracks Music, Voice, Sound; waveforms | free | none |
| S-05 | Stage scene | `director.js` | Signed in | New Stage | 3D stage, Shot tab (see section 12) | free | none |
| S-06 | Character scene | `character.js`, `scenedoc.js` | Signed in | New Character | Sheet: look, voice, pictures, 3D model | free | none |
| S-07 | World scene | `world.js` | Signed in | New World | Look, rules, people, places, stories | free | none |
| S-08 | Place scene | `place.js` | Signed in | New Place | 360° view, key views, sound | free | none |
| S-09 | Prop scene | `prop.js` | Signed in | New Prop | Object kept the same in every shot | free | none |
| S-10 | Story scene | `story.js` | Signed in | New Story | Story, series, episode written into shots | free | none |
| S-11 | Scenes list | `scenes.js` | 2+ scenes | Search, filter by kind, row menu | Open, Use in the scene in front, Duplicate, Delete (with confirm) | free | none |
| S-12 | Plug and play | `scenes.js`, `project.js` | A character or video scene | Drag one onto a stage or a track | Note says what the drop does or why it can't; a re-rendered scene offers to update (`staleBar`) | free | none |
| S-13 | Untitled takes a name | `scenes.js uniqueTitle` | Empty scene | Add first thing | Named from content; clashes numbered ("Poster 2") | free | `smoke` (partly) |
| S-14 | Start from an idea | `starters.js` | Empty scene | Pick a brief | Scene made, its AI asked to build it | mock (AI mock) / paid (real AI) | none |
| S-15 | Back where you left off | `project.js` | Scene with playhead moved | Reload | Playhead, zoom, scroll restored | free | none |

## 4. Timeline editing

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| T-01 | Add clip (text) | `timeline.js`, `editor.js` | Video scene | Press T / use Inspector | Text clip at the playhead on a fitting track | free | `smoke` |
| T-02 | Tracks | `timeline.js` | Video scene | Rename (double-click), hide, lock, mute, solo, volume, pan, magnetic, move, add above/below, remove | Each applies; locked tracks refuse edits | free | `playback4` (add only) |
| T-03 | Move a clip | `timeline.js`, `timeline.ts fitStart` | 2 clips | Drag | Stops against a neighbour or jumps to the nearest gap; never overlaps | free | `editing` |
| T-04 | Trim | `timeline.js` | A clip | Drag an edge | Stops at neighbours | free | `editing` |
| T-05 | Split / delete / duplicate | `timeline.js` | A clip | S, Delete, duplicate | Split at the playhead; delete shows an undo toast | free | `editing` |
| T-06 | Snap | `timeline.js` | 2 clips | Drag near an edge and the playhead | Snaps to neighbours and the playhead | free | `editing` |
| T-07 | Undo / redo | `project.js` | An edit made | Ctrl+Z, Ctrl+Shift+Z | State moves back and forward; one AI edit = one step | free | `editing` |
| T-08 | Copy / cut / paste | `timeline.js` | A clip | Ctrl+C / X / V, also between scenes | Pasted at the playhead keeping spacing and tracks | free | none |
| T-09 | Range select | `timeline.js` | A track | Drag on an empty track, shift-drag ruler, I and O | Range selected; the AI sees it | free | none |
| T-10 | Transitions | `timeline.js` | Two main-track clips | Add at the join | Draws in the player and export | free | none |
| T-11 | Zoom | `timeline.js` | Any | Ctrl+wheel; pinch on a phone | Zoom, kept per scene | free | `phone` (no zoom of the page) |
| T-12 | Autosave | `project.js` | Any edit | Edit, wait | `*` on the tab, then saved; Ctrl+S saves now | free | `smoke` |
| T-13 | Save conflict (409) | `PUT /v1/editor/projects/:id` | Same scene in two tabs | Save in both | The second gets 409 and the newer document, no silent overwrite | free | none (server test `test/editor.test.ts`) |
| T-14 | Edits from elsewhere picked up | `/v1/events` | Two tabs or the AI | Change in one | The other updates | free | none |
| T-15 | Adding where a clip is makes a new layer | `startFor` | Clip at the playhead | Add another | A new track over it (sound: under) | free | none |
| T-16 | Keyboard shortcuts | `?` | Any | Press `?` | Sheet lists them | free | `editing` |

## 5. Player and export

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| P-01 | Player at the playhead | `player.js` | Clips on 4 tracks | Play 30 s | Smooth (p5 fps floor), layered, bottom up | free | `playback4` |
| P-02 | Cuts and scrubbing | `player.js` | Clips cut together | Play, scrub back | No hitch, seek resumes fast | free | `playback` |
| P-03 | Frame handles | `player.js` | A visual clip | Move, size, turn | Snaps to middle and 15° | free | none |
| P-04 | Sound | `player.js` | Audio clip | Play | WebAudio: gain, fades, pan, mute, solo; audio scene shows waveform and spectrum | free | none (headless audio **unconfirmed**) |
| P-05 | Export, plain cut | `video.compose` via the Export sheet | Pictures/clips on the magnetic track | Export | A video; becomes the scene's render | paid (GPU-free CPU, credits **unconfirmed**) | none |
| P-06 | Export, layered | `recordTimeline`, `media.normalize` | Overlapping tracks | Export | Plays once in the browser, recorded, webm converted | free | none |
| P-07 | Export, image PNG | `frameAt` | Image scene | Export | The frame at the playhead as PNG | free | none |
| P-08 | Export, audio WAV | `mixdown` | Audio scene | Export | OfflineAudioContext WAV | free | none |
| P-09 | Share link | `POST /v1/assets/:id?share=1`, `links.ts` | An export | Share | Signed `/dl/` link opens inline for a week; phones get the share sheet | free | none |
| P-10 | Delivery | `deliver.js`, `video.deliver` | Finished video | Open Export sheet | Platform shapes, captions, delivery sheet | paid (unconfirmed which steps) | none |

## 6. Media library

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| M-01 | Grid and thumbnails | `media.js` | Assets exist | Open Media | Thumbnails, "In use" marks | free | `media`, `library` |
| M-02 | Hover plays video | `media.js` | A clip | Hover its tile | Plays muted | free | `library` |
| M-03 | Filters | `#mediaFilter` | Mixed assets | Image, video, audio, 3D chips | Grid narrows | free | `library` |
| M-04 | Search | `#mediaSearch` | Assets | Type | Matches title, labels, tags, recipe | free | `library` |
| M-05 | Detail drawer | `openDrawer` | An asset | Double-click / Enter / info button; Esc | Prompt, recipe, Use in timeline; 3D can't go on a timeline (button disabled with a reason) | free | `library` |
| M-06 | Pick for the AI | `media.js` | Asset | Click a tile | Picked and sent with the next AI message | free | `media` |
| M-07 | Upload | `POST /v1/assets`, `uploadBtn` | File | Button, drag or drop anywhere | Appears in Media; on the timeline: placed; webm/mov normalised; upload checked | free | none |
| M-08 | Delete | see "Confirmed answers" | Customer | Look for Delete | **Not offered** to customers; `DELETE /v1/assets/:id` is admin-only | free | none |
| M-09 | Tags | see "Confirmed answers" | Customer | Look for tags | **No UI**; API field only | free | none |
| M-10 | Use in… | `tools.js` | An image open in the viewer | Use in… | Lists tools whose first or required input takes it | free | none |
| M-11 | Levels of detail | `src/lod.ts` | An image | Open Media | Thumbnails use low levels; `GET /v1/assets/:id/file?lod=` | free | none |
| M-12 | Waiting clips | `project.js PROGRESS` | A queued job | Watch | "In line (2 ahead)" or "Waiting for a free server"; Stop cancels; "Making n" pill | free | `progress` |
| M-13 | Library restore | `src/storage.ts` | Storage on | Request a file missing locally | Restored on demand | free | none |

## 7. Create (every tool group)

All groups: the form is drawn from the tool's own params (`studio.js`); inputs from the library, a drag or an upload; the
price shows on open (B-13); results go to Media; **How it works · every setting** (the tool card, `GET /v1/knowledge/tools/:id`)
opens under each form. Free to *open and read* every form; **running** a tool is paid unless noted. The GPU tools are
never run by this plan without J's OK; the free check is that the form opens, shows a price, and rejects bad input.

| ID | Group (`GROUPS` id) | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| C-01 | Every form opens and is priced | `studio.js`, `GET /v1/editor/catalog` | Signed in | Open each tool in each group | Price on open; changes when a cost option changes | free | `createprice` |
| C-02 | Images and textures (image.generate, edit, cutout, expand, relight, upscale, angles, panorama, texture.maps, normals, segment, layers, pose…) | `workflows/`, `src/tools/` | Signed in | Run one | Result in Media, opens in the viewer (cutout, not mask) | paid (GPU) | none |
| C-03 | Video (t2v, i2v, extend, animate, motion, talk, lipsync, control, control-wan, seedance, kling…) | same | Signed in | Run one | Clip in Media; can go to the timeline | paid (GPU or API) | none |
| C-04 | 3D and rigging (views3d, mesh.from-image, mesh.rig, blender.character) | `docs/3d-characters.md` | Signed in | Run a view sheet then a model | More than one view is required (single image refused) | paid (GPU) | none |
| C-05 | Animation (motion.from-text, retarget, sprite.sheet, image.transform) | `src/tools/` | Signed in | Run `sprite.sheet` and `image.transform` | These two are CPU: cents | free for the CPU tools / paid for motion | none |
| C-06 | Voice and sound (audio.voice, sfx, music, dialogue, voice design) | `docs/audio.md` | Signed in | Add to timeline at the playhead | Voices from house voices (`hv_`), never ElevenLabs; "Offline" never shown for these | mock (`HAWKESGEN_AUDIO_MOCK=1`) or paid | none |
| C-07 | Chains (`asset.make` steps, `$prev`) | `src/tools/pipeline.ts` | Signed in | Run a chain | Steps run in order, reuse hit, priced once | paid | none |
| C-08 | Tools needing the SSH fleet | `studio.js` | AWS off | Open them | "Offline" label while the fleet is down | free | none |
| C-09 | Job failure and retry | `lib.js jobStatusText` | A failing job | Run, watch, Retry | Plain cause, Retry shows the estimate, Stop while running | free (forced fail) | `progress` |
| C-10 | No GPU available | `src/providers/gpu/nogpu.ts` | All providers out | Run a GPU tool | Fails at once with a reason, or waits ≤ `queue.gpuWaitMinutes`; no job left "running" | free | none |

## 8. Tools on the selection

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| X-01 | Picture tools | `tools.js clipTools`, `GET /v1/editor/tools` | Image clip | Open the Inspector / right-click | Remove background, Edit, Repaint, Expand, Relight, Upscale, Animate; only tools this Gen has | paid | none |
| X-02 | Clip tools | same | Video clip | Open the Inspector | Change, Restyle, Swap a person, Continue the shot, Grab this frame, New voice, Upscale, Smooth motion | paid | none |
| X-03 | Result replaces the clip | `tools.js` | A tool finished | Wait | The clip is replaced in its spot, one undo step | paid | none |
| X-04 | Inspector | `editor.js` | Any selection | Select a clip, a track, nothing | Ask-the-AI chips first, sliders and swatches, numbers under "Fine-tune" (closed) | free | none |

## 9. The AI pane

The AI follows the tab in front. It runs on the account's own Claude, else the house AI (Gen app accounts), priced as
`ai_turn`. With `HAWKESGEN_AI_MOCK=1` a test account can queue canned answers (`docs/ai-mock.md`), so the **mock**
column below means "plays with no Claude call".

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| A-01 | AI editor (video, image, audio) | `ai.js`, `src/editor.ts assistantTurn` | Mock answer queued | Type a message | Canned words appear; the title is added; one undo step | mock | `aimock` |
| A-02 | Queue while busy | `ai.js` | AI answering | Send two messages | Second waits visibly (Remove), goes next; box cleared | mock | none |
| A-03 | Proposal over `autoCredits` (40) | `ai.js` | Answer with generation > 40 credits | Send | Comes back as `proposed`; one tap applies | mock | none |
| A-04 | No connection | `ai.js` | Not house AI, no key | Send | Pane says how to connect | free | none |
| A-05 | House AI charge | `houseai.ts` | Gen app account | Send | `ai_turn` = cost × markup, at least `minCredits` | mock (set `cost`) | none |
| A-06 | AI director | `director.js`, `POST /v1/director/shots/:id/assistant` | Stage | Ask for a shot | Whole shot returned; shots planned in order | mock | none |
| A-07 | Character AI | `sceneai.ts`, `POST /v1/scenes/:id/assistant` | Character | Ask | Whole sheet plus jobs; `gen: n` elements | mock | none |
| A-08 | World / place / prop / story AIs | `worldai.ts` | Each scene | Ask | Answers per kind; canon check | mock | none |
| A-09 | Image AI, Audio AI | `ai.js` | Each scene | Ask | Image: frame at the playhead; audio: the mix | mock | none |
| A-10 | Generate op limited to the AI catalog | `#134` | Any | Ask for `comfy.graph` etc. | Only catalogued tools are queued | mock | none (server tests) |
| A-11 | Legacy `/v1/assistant/*` metered | `#135` | Any | Call | Charged like the others | mock | none |
| A-12 | AI memory | `memory.js`, `showrunner/memory.ts` | Signed in | Account > Your AI > Forget | Memory cleared | free | none |

## 10. Director and stage

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| D-01 | Stage plays shot | `director.js`, `stage-math.js` | Stage with a cast | Play | Moves match `blender.render` axes (`test/director.test.ts`) | free | none |
| D-02 | Place things | `director.js` | Stage | Click, gizmo Move/Turn/Size (W E R), Delete, Esc | Within 25 m; right-click menu | free | none |
| D-03 | Drops on the stage | `director.js` | A character, model, picture | Drop | Cast / prop / screen | free | none |
| D-04 | Camera, camera keys, Look/Depth | `director.js` | Stage | Key the camera, toggle Look | Diamonds on the bar; depth view | free | none |
| D-05 | Lines and voices | `director.js` | Stage | Add a line and a voice | Lines laid on Voice at their moment | mock (audio mock) | none |
| D-06 | Photo | `director.js` | Stage | Photo | Opens as an image scene | paid (GPU) | none |
| D-07 | Film it | `director.js`, `image.control`, `video.control` | Stage | Film it | Browser records frame and depth; Gen paints and films | paid (GPU) | none |
| D-08 | Film the sequence | `director.js` | 2+ shots | Film the sequence | Each shot filmed, cut into a new video scene; page must stay open | paid | none |
| D-09 | Blender path | `POST …/blender?quote=1` | Cast with models | Quote | Priced; queues until the fleet is back | free (quote) / paid | none |
| D-10 | Shot list (scenes) | `/v1/director/scenes/:id` | Stage | Next shot, reorder | Shared identity carried by id | free | none |

## 11. Characters, worlds, showrunner

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| H-01 | Character sheet | `character.js` | Character | Edit look, voice preview, role pictures | Versioned saves, undo, follows jobs | free (voice preview: mock) | none |
| H-02 | Make their look / pictures | `docs/identity.md` | Character | Make their pictures | Pack with lock text; approved with Lock their look | paid | none |
| H-03 | Make the 3D model | `character.js` | Character | Make the model (optionally rigged) | Cutout → view sheet → mesh.views3d | paid | none |
| H-04 | Cast reaches shots | `castFromCharacters` | Character on a stage | Rename the character | Every shot shows the new name | free | none |
| H-05 | World look inherited | `worlds.ts withWorld` | A world | Make anything inside it | The look is applied; `labels.world: "off"` turns it off | paid | none |
| H-06 | Start a world, packs | `worldroutes.ts` | Signed in | Start a world | Place, prop and pack plans | paid | none |
| H-07 | Canon check | `canonCheck` | A world with rules | Make contradicting content | Flagged | mock | none (`test/worlds.test.ts`) |
| H-08 | Showrunner turn | `POST /v1/showrunner/turn`, `showrunner.js` | AI mock | Send "a 60-second teaser about…" | Plan, critique, price, one approval card | mock | none |
| H-09 | Production runs | `production.ts` | Approved card | Approve | Resumable steps through `make.checked`; checked with `assess` | paid | none |
| H-10 | Review mode | `review.js` | A cut | Re-take one shot | Keep or Undo | paid | none |
| H-11 | Making loop feedback | `POST /v1/make/feedback` | A take | Pick / discard | Feedback recorded | free | none |

## 12. Command palette, phone, zoom

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| K-01 | Palette | `palette.js` | Signed in | Ctrl+K | Scenes, new scenes and ideas, actions, panes, Create tools; else "Ask the AI" | free | none |
| K-02 | Open picker | `scenes.js` | 2+ scenes | Ctrl+O | Picker of every scene | free | none |
| F-01 | Phone: no sideways scroll | `gen.css` | 390x844, touch (needs #136; **not on beta yet**) | Open each pane | No horizontal scroll; primary buttons on screen; controls ≥ 44 px | free | `phone` |
| F-02 | Phone tabs | `#mobileTabs` | Phone | Tap Edit, Media, Create, Scenes, Inspect, AI | Each shows its sheet; the center and a timeline strip stay | free | `phone` |
| F-03 | Phone drag | `dragdrop.js` | Phone | Hold a tile, drag to a track | Ghost follows, track lights | free | none (touch drag **unconfirmed**) |
| F-04 | Sheet sizing | `#sheetGrip` | Phone | Drag the grip | Sheet grows to nearly the whole screen | free | none |
| F-05 | Desktop areas | `gen.js AREAS` | Desktop | Drag an edge; past half folds; double-click | Sizes kept per browser | free | none |
| F-06 | No page zoom | `nozoom.js` | Phone, desktop | Pinch, Ctrl+wheel on the page | Page never zooms; the timeline's own zoom works | free | `phone` |
| F-07 | Menus as sheets | `lib.js` | Phone | Open a menu | Opens from the bottom and scrolls inside | free | `phone` |
| F-08 | Drag explains itself | `dragdrop.js` | Any | Drag something unsupported | Red note says why; drop toasts the reason | free | none |

## 13. MCP, API, keys, SDKs

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| I-01 | MCP sign-in (OAuth) | `/mcp`, `/oauth/authorize`, `mcp-oauth.ts` | An editor | Connect without a token | 401 naming `/.well-known/oauth-protected-resource/mcp` (200 on beta); register, Google, Allow, `hgm_` token | free | none |
| I-02 | Connections | `/v1/users/me/connections` | Connected | List and revoke | Revoked token stops working | free | none |
| I-03 | Friendly tools | `mcp-make.ts` | Connected | Call `account`, `list_voices`, `upload_file` | Free: account, list_voices, upload (one-time `/up/` link, 30 min) | free | none |
| I-04 | Making tools | same | Connected | `generate_image`, `edit_image`, `remove_background`, `transform_image`, `upscale_image`, `make_texture`, `make_skybox`, `character_views`, `make_3d_model`, `rig_character`, `animate_character`, `animate_image`, `make_video`, `make_sprite_sheet`, `voice_line`, `sound_effect`, `make_music` | Output as signed `/dl/` links (a day); long jobs return a `task_id` for `get_task`; `transform_image` is CPU | paid (voice/sfx: mock with audio mock) | none |
| I-05 | API keys | `auth.ts`, `X-Hawkesgen-Project` | Owner | Make a key per role | `user` keys scoped to their projects; customer keys can't touch OPS routes (403) | free | none (`test/tenancy.test.ts`) |
| I-06 | Platform token | `platform.ts` | Portal JWT | Call with it | Scopes decide what runs; viewers can't run | free | none (`test/platform-token.test.ts`) |
| I-07 | JS / Python / Unity SDKs | `clients/` | Project copy | `node bin/hawkesgen-sdk.mjs status` | No product behind; `X-Hawkes-Client` listed under `/v1/health` `client.behind` (empty on beta) | free | none |
| I-08 | Analytics collect | `POST /v1/analytics/collect`, `/sdk/analytics@1.js` | Registered origin | POST a valid batch | 202; stored; readable by admin queries | free | none; route **live on beta** (202); storing **unconfirmed** |
| I-09 | Events stream | `GET /v1/events` | Signed in | Open the app idle | One stream, zero fetches idle (`test/no-polling.test.ts`) | free | `smoke` (partly) |
| I-10 | Health | `GET /v1/health` | None | GET | `commit`, `lane`, `client.behind` | free | none |
| I-11 | Tenancy | `test/tenancy.test.ts` | Two customers | Read each other's blobs, jobs, assets | Refused | free | none |

## 14. Admin and legacy

| ID | Feature | Route / files | Preconditions | Steps | Expected | Cost | Scenario |
|---|---|---|---|---|---|---|---|
| Y-01 | Admin sign-in | `/admin`, `users.ts isGenAdmin` | Admin email via Google | Open `/admin` | Admin link shows only for admins; others get the sign-in page | free | none |
| Y-02 | Overview, Jobs, Entities, Library | `dashboard/app.js` | Admin | Open each tab | Lists load; filters work | free | none |
| Y-03 | Playtests | admin tab, `livePlay.ts` | Admin | Open | Live runs, frames | free | none |
| Y-04 | GPU fleet, Machines | admin tabs | Admin; AWS off | Open | Servers shown (none), samples; **never start or terminate a server** | free | none |
| Y-05 | Tools, Presets, Workflows | admin tabs | Admin | Open; reload workflows | Lists; `POST /v1/workflows/reload` works | free | none |
| Y-06 | Accounts | `accounts.ts` | Admin | Search, gift credits with a note, disable | Ledger shows note, never who | free | none |
| Y-07 | AI (house AI) | `houseai.ts` | Owner | Open | Key stored encrypted, mode, markup | free | none |
| Y-08 | Bench | `src/bench/` | Admin | `hawkesgen bench run --mock` | Scores, no spend | mock | none |
| Y-09 | Making | `make/` | Admin | Open | Proposed craft notes and routing changes, approve/reject | free | none |
| Y-10 | Usage, Settings | admin tabs | Admin | Open | Costs by project; settings editable | free | none |
| Y-11 | `/home` | `public/landing.html` | None | Open | Page answers 200 ("Hawkes Play"); what it shows and whether its links work is **unconfirmed** | free | none |
| Y-12 | `/app` | `public/game-editor.html` | None | Open | Page answers 200 ("Game Builder", needs `/v1/games`); inline login 410 with passwords off | free | none |
| Y-13 | `/play?game=<id>` | `public/player.html` | A game | Open | Plays the game; with no id: **unconfirmed** | free | none |
| Y-14 | Report button | `report.js` | Beta | Press 🐞 | Loads a Studio project's report line when set | free | none |

## How to run it

1. **Free pass (every night, no spend):** all rows marked *free* and *mock*. The twelve scenarios cover L-01…L-03, L-05,
   B-04/B-13, S-01/S-02, T-01…T-07, T-12, T-16, P-01/P-02, M-01…M-06, M-12, C-01, C-09, A-01 and F-01/F-02/F-06/F-07.
2. **Mock pass:** AI mock queued on a test account, `HAWKESGEN_AUDIO_MOCK=1`, Stripe test mode: A-02…A-11, B-05…B-09,
   H-07, H-08, C-06, Y-08.
3. **Paid pass (J's OK, priced with `POST /v1/estimate` first):** C-02…C-04, C-07, X-01…X-03, D-06…D-09, H-02, H-03, H-05, H-09.
   Never in a nightly run.
4. Failures go to the backlog (Studio) and become fix tasks. Add a scenario when a row stays *none* and is worth guarding.

**Where nothing plays a row yet** (the rows marked *none*): sign-in with real Google, Stripe, the five non-timeline scene
kinds, the Director, characters and worlds, the showrunner, MCP, admin tabs and the legacy pages are checked by server
tests (`test/*.test.ts`, 130 files) and by hand until scenarios are added.

## Known unfinished

From the docs' own notes, the code, and the checks above. Nothing here blocks the test plan; it explains why a row can't pass.

- **No media delete or tags in the app** (this plan): files can only be removed by an admin through the API; tags can't be set from the UI.
- **Hawkes Play pages** (`/home`, `/app`, `/play`) are the pre-Gen product, still routed, not covered by a scenario; `public/app.html` ("Creator Studio") is unrouted. Their future is undecided (**unconfirmed** whether to retire).
- **Plan prices are provisional** (Creator $12/1,500, Pro $39/5,500: AGENTS.md "Plans"); Stripe keys and webhook per lane must be set by J; whether beta has test keys is unconfirmed.
- **`audio.revoice`** (changing a voice) is ElevenLabs only and kept out of the editor's voice list.
- **Audio Phase 1 left out** stems, cover/edit and MiniMax Music 3 vocals (`docs/audio.md`); MMAudio/Hunyuan-Foley "not wired" (`docs/audio.md`).
- **Make loop refunds:** a partial refund for a partly used `make.checked` run is "not built" (`docs/make.md`).
- **Long work needs the page open:** filming a sequence runs in the browser (`docs/worlds-roadmap.md`); the showrunner's server-side productions are the fix for productions, not for this.
- **Quality checks on Cloud Run:** `quality.identity` stays local; the CPU image for `post/quality/*.py` is "Not built or deployed (J's)" (`docs/bench.md`).
- **CPU suite on Cloud Run:** the image built and run in Cloud Run (cold start, BiRefNet speed, real billed seconds) "not yet" (`docs/cpu-cloudrun.md`).
- **Playtest cost rates** for the CPU service "are not yet checked against the bill" (`docs/playtest-cloudrun.md`).
- **Native playtests:** a real Unity Win64 build on the RunPod GPU, and Gen's runner list on beta, are "still to do" (`docs/play-native.md`).
- **Unity customer builds:** a TODO about the Unity account in the container (`docs/unity-cloudrun.md`, around line 238).
- **GPU model volumes** per kind of endpoint: "J agreed the shape, not started" (`docs/gpu-providers.md`).
- **AWS is suspended** and there is no GPU quota (AGENTS.md): the SSH-fleet tools show Offline; GPU work runs on RunPod/Modal/Cloud Run only.
- **Beta is behind main** (#136 phone pass, #138 prices up front): rows F-01, L-03 and B-13 can't pass on beta until it is merged.
- **Roadmap** phases still open are listed in `docs/worlds-roadmap.md` (Phase 6, the sleek front; Phase 7, games and sharing).
