# Workflows: ComfyUI as tools

Every folder in `workflows/` is a ComfyUI workflow that Hawkes Gen runs as a tool. No code is needed:

```
workflows/<folder>/
  workflow.json   the manifest (below)
  graph.json      the ComfyUI API graph that runs
  source.json     the workflow it came from (template or upload), kept for re-conversion
```

## Getting a workflow in

There are three ways, all through the same converter (`src/workflows/convert.ts`):

- **From ComfyUI's template library:** dashboard → Workflows → click a template to preview the conversion →
  Import. Or call `POST /v1/workflows/import {"template": "image_z_image_turbo", "id": "image.generate"}`.
  The MCP tool is `hawkesgen_import_workflow`.
- **From a workflow J builds in ComfyUI:** save or export it (UI or API format), then dashboard → Workflows →
  "Import my ComfyUI workflow…".
- **By hand:** write `graph.json` in API format and a manifest. `image.upscale` was made this way.

### What the converter handles

The converter turns the editor's format into what the server runs, the way ComfyUI's frontend does:

- subgraphs, nested ones too
- promoted widgets: the value saved on the instance wins over the inner node's
- Reroute nodes
- the old PrimitiveNode, and the real `Primitive*` nodes
- bypassed nodes (inputs pass through by type)
- muted nodes (dropped)
- notes
- seed "control after generate" values
- V3 dynamic inputs, sent with dotted names (`format.codec`, `values.a`)

Previews that pass data on (PreviewImage, MaskPreview) stay in the graph but don't count as outputs.
`Save3DAdvanced` becomes `SaveGLB`. Anything that doesn't feed a save node is pruned.

237 of the 245 open-source templates convert and check cleanly (`npm test`). The rest are text-only LLM
templates, plus a few that only wire editor previews.

### What the draft manifest finds

- **Inputs:** Load Image, Load Video and Load Audio nodes. Their titles become the names.
- **`prompt` and `negative`:** found by following each text encoder to a sampler's positive or negative input.
  `lyrics` and style `tags` are found too.
- **Seeds, sizes and lengths:** `seed`, `width`, `height`, `frames` (latent length), `seconds`, `fps`.
- **Advanced params:** `steps` and `cfg`.
- **Primitive nodes:** named by what they feed, or by their title ("Int (Steps)" becomes `steps`).
- **Models:** every model file the kept nodes name, with the download links the template carries
  (`properties.models`).

The draft runs as it is. Then curate it.

## Curating (the manifest)

```json
{
  "id": "image.generate",
  "version": 1,
  "title": "Generate an image",
  "description": "What it's for, when to use it instead of another tool.",
  "family": "z-image",
  "output": "image",
  "tags": ["image", "text-to-image"],
  "seconds": 8,
  "post": ["seamless"],
  "models": [{ "dir": "diffusion_models", "file": "z_image_turbo_bf16.safetensors", "url": "https://huggingface.co/..." }],
  "inputs": { "image": { "kind": "image", "required": true, "description": "...", "targets": [["12", "image"]] } },
  "params": {
    "prompt": { "type": "text", "required": true, "example": "...", "targets": [["57:27", "text"]] },
    "width": { "type": "integer", "min": 256, "max": 2048, "default": 1024, "targets": [["57:13", "width"]] },
    "seed": { "type": "integer", "min": 0, "max": 281474976710656, "targets": [["57:3", "seed"]] },
    "steps": { "type": "integer", "default": 8, "advanced": true, "targets": [["57:3", "steps"]] }
  },
  "outputs": ["9"],
  "source": { "template": "image_z_image_turbo" }
}
```

| Field | What it does |
|---|---|
| `targets` | Which `[node id, input name]` pairs a param or input sets. One param can set several (e.g. `seconds` sets both the latent length and the text encoder's duration). |
| `family` | The set of models this loads. The queue unloads a server's models when the family changes and keeps a server on one family for back-to-back jobs. Tools that share models should share a family. |
| `models` | Installed on a server the first time a job needs them. Swap a big model for one the servers already have when it's the same architecture (`image.angles` uses the core fp8 Qwen-Image-Edit instead of the 40 GB bf16). |
| `outputs` | The save nodes whose files come back. Their titles become the outputs' titles in the library. |
| `post` | `"seamless"` adds `seamless` and `blend` params that tile image outputs on this PC. |
| `version` | **Bump it when the same params would now make a different result.** Recipes made with the old version then read as out of date. |
| `advanced` | Hides a param behind "More settings" in the dashboard and the Unity window. |

Edit manifests in the dashboard (Workflows → Edit) or in the file, then `POST /v1/workflows/reload` (the
dashboard does this for you). `npm test` checks every workflow against the server's node definitions, using
the copy cached in `.data/comfy-cache/`. "Refresh catalog from a server" updates that copy.

## Models and disk

- Core models (`server/models.json`) install when a server launches and are never removed.
- Workflow models install on demand, for each server separately. Disk is checked first, with 15 GB kept
  spare.
- When there isn't room, the server's least recently used non-core models are removed (setting
  `fleet.autoPrune`, on by default). They download again when needed, at about 40 MB/s from Hugging Face,
  so a 20 GB model takes about 8 minutes.
- Dashboard → GPU fleet → Models lists what each server has, what uses it, and lets you remove files.

## Testing a new tool

1. Import it and curate it.
2. Run `npm test`.
3. Run it once on a running server, from the Tools tab or `hawkesgen.cmd run <id> ...`.
4. Look at the output: the library shows images, video, audio and 3D.
5. Check the job's log and its ComfyUI graph (job → ComfyUI graphs; drag it into ComfyUI to debug).
