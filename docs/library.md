# The library: entities, slots and versions

Every product edits the same things: a fighter's concept, its side view and poses, a stage's art, a set's model, a
shot's look. Before this, each product kept its own takes, picks and old versions in folders on J's PC
(`_takes/`, `_old/`, `_recipes/`, `--pick stand=123`). The library keeps them in Hawkes Gen. Every product, Studio,
Claude (MCP) and the cloud agents see the same thing and can work on it.

```
entity   doseofdestruction/break        a fighter (kind: fighter), its name, data: { canon, look, slots: {...} }
  slot   concept                         v1 (current)
  slot   side                            v4 (current)  v3 (old)  v2 (take: "visor bigger")  v1 (discarded)
  slot   pose/air                        v2 (take)  v1 (take)                    <- none picked yet
  slot   clip/jab                        v1 (current, made from side v4 by video.i2v)
```

- **Entity:** a thing a product cares about, `<project>/<slug>`: a fighter, an enemy, a stage, a set, a prop or a shot.
  It has a `kind`, a `name` and free `data`. The fields the library uses are:
  - `canon`: facts
  - `look`: what it looks like, in words
  - `slots.<slot>`: a slot's `brief` and its own recipe (`make`), plus any field its recipe uses (`start`, `end`)
- **Slot:** a named role on an entity, lowercase with up to three slashes: `concept`, `side`, `pose/air`, `clip/jab`,
  `model`, `animation/walk`, `voice/hello`.
- **Version:** one library file in a slot, numbered per slot. Its status is one of:
  - `take`: a candidate
  - `current`: the one in use, at most one per slot
  - `old`: was current
  - `discarded`

  Each version also keeps a `note` (feedback), `by` (who), the `job` that made it, and `made_from` (the slot versions
  and assets the job used).

## Slot references

Anywhere a job takes a file, or in a chain's steps, a slot reference means a slot's file:

| Reference | Means |
|---|---|
| `slot:doseofdestruction/break/side` | the current version |
| `slot:doseofdestruction/break/side@3` | version 3 |
| `slot:doseofdestruction/break/side@latest` | the newest that isn't discarded |
| `slot:./side` | the same entity (inside its own recipes) |

Gen swaps the reference for the asset when the job is submitted. So the job's recipe follows the slot: pick a new
side view, and everything made from the old one reads as out of date, so it's made again rather than handed back by
`reuse`.

## Making, revising, picking

- **Make:** `POST /v1/entities/<id>/slots/<slot>/make` runs the slot's recipe. The job's outputs come back to the
  slot as takes when it ends; takes the library hands back (`reuse`) land there too. The recipe comes from, in order:
  1. the request's `make`
  2. the entity's `data.slots.<slot>.make`
  3. the project's `kinds.<kind>.slots.<slot>` in `presets/<project>.json` (`pose/*` matches every pose)

  A recipe is `{ tool | preset, params, inputs }`, or a chain `{ steps, candidates, pick, pickAt, saves }`. `saves`
  maps a step's save name to a slot, so one chain fills several slots (Blender render → look → video).
- **Template fields:** strings in a recipe can use:
  - `{name}`, `{look}`, `{canon}`
  - `{brief}` (the slot's brief)
  - `{feedback}` (what the caller asked for)
  - `{style}` (the project's style line)
  - `{part}` (the slot's last word, `air` for `pose/air`)
  - any field of the slot's data (`{start}`, `{end}`)

  An input left naming a blank (an unset `{end}`) is dropped.
- **Revise:** `POST .../revise { feedback }` changes the current (or a given) version.
  - An image is edited in place with `image.edit` ("make the visor bigger"; the rest stays).
  - Anything else is made again by the same tool and params with the feedback added.
- **Pick:** `PATCH /v1/versions/<id> { status: "current" }`; the old current becomes `old`. Also `discarded`,
  `take` (restore) and `{ note }`.

`presets/doseofdestruction.json` has the first kind, `fighter`. Its recipes are DoD's own tuned settings (side views
from the reference, poses from the side view, clips from a start pose to an end pose).

## API

| Route | What |
|---|---|
| `GET /v1/entities?project&kind&q&tag&archived&limit&offset` | Entities, each with its slots' current version and counts |
| `POST /v1/entities` | `{ project, name, kind, slug?, data?, tags?, upsert? }` |
| `GET /v1/entities/<project>/<slug>` | One entity and its slots |
| `PATCH /v1/entities/<project>/<slug>` | `{ name, kind, data (merged one level; null removes), tags, archived }` |
| `GET /v1/entities/<id>/slots/<slot>` | The slot's versions, newest first, with each file's kind, URL and prompt |
| `POST /v1/entities/<id>/slots/<slot>/versions` | `{ file: blob:<sha> \| asset:<id>, status?, note?, title? }`: a file into the slot |
| `POST /v1/entities/<id>/slots/<slot>/make` | `{ make?, feedback?, count?, params?, note?, reuse? }` → the job |
| `POST /v1/entities/<id>/slots/<slot>/revise` | `{ feedback, version?, count?, references? }` → the job |
| `PATCH /v1/versions/<id>` | `{ status?, note? }` |
| `GET /v1/events` | Server-sent events: `job` and `library` (`{ type: entity \| version, entity, slot, version, status }`) |

API keys see only their projects' entities.

## Clients

All four clients have the same calls:

| Client | Calls |
|---|---|
| **JS** (`clients/js/hawkesgen.mjs`, v6) | `entities`, `entity`, `createEntity`, `updateEntity`, `slot`, `current`, `addVersion` (a path, bytes, `asset:` or `blob:`), `pick`, `discard`, `restore`, `note`, `make`, `revise`, `watch` (live events, Node and browsers), `exportSlots` (writes current versions into a product's own folder layout, e.g. DoD's `AllTheCharacters/<Name>/poses/{part}.png`, skipping files that already match) |
| **Python** (`clients/python/hawkesgen.py`) | `entities`, `entity`, `create_entity`, `update_entity`, `slot`, `current`, `add_version`, `pick`, `discard`, `note`, `make`, `revise` |
| **Unity** (`com.hawkes.gen` 0.2) | `HawkesGenClient.Entities`, `Entity`, `CreateEntity`, `UpdateEntity`, `Slot`, `AddVersion` (uploads), `SetVersion`, `Make`, `Revise`, `Upload` |
| **MCP** | `hawkesgen_entities` (list, one, a slot's history), `hawkesgen_entity_edit` (create, update, add, pick, discard, restore, note), `hawkesgen_entity_make` (make or revise, and wait) |

## The UI kit (web components)

`clients/js/hawkesgen-ui.mjs` is the library as drop-in web components for any product's tools. It has no framework
and no build step, and needs `hawkesgen.mjs` next to it. Gen also serves both at `/client/hawkesgen-ui.mjs` and
`/client/hawkesgen.mjs`.

| Element | What |
|---|---|
| `<hg-library project kind thumb open-inline>` | A searchable grid of entities. Each card shows its first current image from `thumb` (`side,concept`) and the takes waiting. **New** creates one. `open-inline` opens a card in place; otherwise it fires `hg-select { id }`. |
| `<hg-entity entity>` | Name, look and canon (edited in place). Every slot it has, names in its data, or its kind lists, in the kind's order. **Add slot** (e.g. `pose/kick`). |
| `<hg-slot entity slot>` | The version in view (image, video, audio or a file link), with its status, who, when, made from and the prompt. A strip of every version. **Use this** (pick: fires `hg-pick`), **Discard**/**Restore**, a note, the slot's brief, feedback with **Revise this** and **Make takes** (1–4), live job progress, and **Add file** or drop a file. Loads when scrolled into view. |

- **Setup:** `configure({ url, key, project })` before adding elements, or set `window.hawkesGenConfig` before loading
  the module.
- **Files:** media streams from Gen's file URL when the page sends no key. With a key, the kit fetches the bytes once
  and caches them.
- **Theme:** `--hg-bg`, `--hg-panel`, `--hg-fg`, `--hg-muted`, `--hg-accent`, `--hg-line`, `--hg-radius`,
  `--hg-font`. Light or dark follows the page until set. Its internal variables are `--hgk-*`, so a page's own
  `--panel` can't clash.
- **Where it's used:**
  - Gen's dashboard: the **Entities** tab.
  - DoD's dev tools: the **Library** tab.

**Keys stay out of browsers.** A product's dev server can relay `/api/.../gen/v1/*` to Gen and add the key on the
server side, as DoD's `tools/devApi.mjs` does. The page then configures the kit with
`url: location.origin + '/api/dev/gen'` and no key.

## Folders <-> the library

`clients/js/hawkesgen-folders.mjs` is a Node module, run by `node bin/hawkesgen-folders.mjs
status|import|export <mapping.json> [--only <folder>] [--dry] [--adopt]`. It moves files between a product's own
folders and the library. A mapping file in the product's repo says which file is which slot. DoD's is
`doseofdestructionwebsite/hawkes.library.json`: each `AllTheCharacters/<Name>/` is a fighter.

| Slot | Current | Also brought in |
|---|---|---|
| `concept` | `*.{jpg,jpeg,png}` | |
| `reference` | `anims/_reference.png` | |
| `side` | `anims/_side.png` | takes `anims/_side-*.png`, each with its recipe JSON (prompt, seed) |
| `pose/{name}` | `poses/{name}.png` | takes in `poses/_takes/` |
| `clip/{name}` | `anims/{name}.mp4` | takes in `anims/_takes/`, old versions in `anims/_old/` |

A flat folder with one file per entity uses `"layout": "files"`. In that layout `{entity}` in a pattern is the entity's
name, `entities` lists name patterns to keep, and `skip` lists name patterns to leave out. One file can hold several
mappings: `{ ...shared, "mappings": [...] }`, one per kind. PH Origins' `phoriginswebsite/hawkes.library.json` uses this
for `assets/models/*.glb`: `ch*`, `hero` and `parasite-*` are characters, and the rest are props. Its level editor has
Tools → Library (`src/editor/library.ts`), which talks to Gen through the dev server (`tools/genLibrary.mjs`).
Studio writes a pick back with the mapping for that entity's kind.

How the bridge behaves:
- **Re-importing is safe:** files already in a slot (same bytes) are skipped.
- **The library's pick stands:** a current file that matches a take picks that take, but only while the slot has no
  current. After that a different file in the folder is reported as `differs`; `--adopt` makes the folder win.
- **Export:** writes each current version to its folder path, only where the bytes differ. The game and the old tools
  keep reading the folders as before.
- **Cost of DoD's Break:** 117 files in about two seconds against a local Gen.

## How a product uses it

A product keeps its game files where its engine wants them; the library is where they're worked on.

1. **Bring it in once:** an importer turns the product's folders into entities and versions (files present →
   current, `_takes/` → takes, `_old/` → old), with their recipes.
2. **Work in the library:**
   - Dev tools, a level editor or a Unity window show the slots.
   - The artist picks, discards, gives feedback, makes more, revises.
   - An agent can do the same through MCP.
3. **Write back:** `exportSlots` (or Studio, for repos) writes the current versions into the product's layout. Only
   files that changed are written.

The code is `src/entities.ts` (the model, slot references, recipes, filing job outputs), the routes in `src/api.ts`,
and the filing in `src/jobs.ts` (`fileJobOutputs` when a job ends, and for reused jobs). The tests are
`test/library.test.ts` (the model) and `test/library-api.test.ts` (HTTP through the JS client, with a real local job).
