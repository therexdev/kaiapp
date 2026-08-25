# Image generation — spec and the decision it needs

**Status: SPEC ONLY. Nothing here is approved or started.**
Opened 2026-08-25 after a tester built a working prototype and argued for
ComfyUI. This document exists to make the choice legible before any code, not
to record a decision already taken.

The owner's position: image generation belongs in the MVP.
The honest counterweight, stated once and then not laboured: this is the
largest new dependency the app would have ever taken, and it lands during a
testing-and-bugfixing phase. That is a scope call, and it is the owner's to
make. What follows assumes it is being made and costs it out properly.

---

## 1. What the tester actually built

A Gradio front-end on `127.0.0.1:7860` posting to a ComfyUI API on
`127.0.0.1:8188`, with the model work done entirely by ComfyUI. Their own
summary is accurate and worth repeating: **it is not a plug-and-play app.** The
front-end is a thin shell; reproducing it means reproducing a ComfyUI
environment.

They were also right to tunnel only the Gradio port and never expose 8188.
ComfyUI's API has no authentication and accepts arbitrary workflow graphs — it
is a remote code execution surface by design, not by accident.

### What the workflow graph does

Reading `kai_image.json` rather than trusting the summary, the live path is:

```
408 prompt ──► 212 TextEncodeQwenImageEditPlus ──► 387 ConditioningKrea2Rebalance
                     ▲            ▲                          │
        213 CLIPLoader│      39 VAELoader                     ▼
   (qwen3vl_4b_fp8)   │   (qwen_image_vae)          31 KSampler ──► 8 VAEDecode ──► 417 SaveImage
                      │                              ▲
   385 GGUF Loader ──► 382 Switch ──► 360 MultiLora ──┘
   (Krea-2-Turbo-Q4_K_M)
```

Sampler settings: `ddim` / `beta57` / **8 steps** / **CFG 1** / denoise 1, at
1056×1408. Eight steps at CFG 1 is a distilled "turbo" configuration — fast,
and deliberately not using classifier-free guidance.

### Four findings the tester will want

These come from the graph, not from opinion:

1. **Only three of the four listed models are actually in use.** Switch node
   `382` has `select: 2`, which routes `input2` — the **GGUF** loader (`385`).
   `krea2_turbo_fp8.safetensors` is loaded by node `359` and then discarded.
   Anyone reproducing this can skip that download for now.
2. **Positive and negative conditioning are the same node.** KSampler `31`
   takes `387` for *both*. `ConditioningZeroOut` (`369`) exists but is wired to
   nothing. At CFG 1 the negative branch is ignored, so this is harmless
   today — and silently wrong the moment anyone raises CFG above 1.
3. **The upscale chain is dead**, as they said: `233` reads from `8`, but
   `SaveImage` also reads from `8` and nothing reads `233`.
4. **Node `410` "Switch Prompt" is dead too** — its output goes nowhere.

### The real dependency surface

Not just four model files. The graph needs these custom node packs:

| Node | Pack |
|---|---|
| `LoaderGGUFAdvanced` | ComfyUI-GGUF |
| `ImpactSwitch` | Impact Pack |
| `AcademiaSD_MultiLora`, `AcademiaSD_Resolution`, `AcademiaSD_Downloader` | AcademiaSD suite |
| `ConditioningKrea2Rebalance` | Krea2-specific |
| `TextEncodeQwenImageEditPlus` | Qwen-image nodes |

Plus ComfyUI itself, Python, and PyTorch with a working CUDA stack.

**This is the crux.** We currently ship two self-contained native engines
(llama.cpp, whisper.cpp) as pinned binaries with verified hashes. ComfyUI is a
Python application whose behaviour depends on five community node packs that
are versioned loosely, update independently, and break each other. Shipping it
means shipping other people's Python and owning every way it breaks on a
stranger's machine.

---

## 2. The hardware floor, which is the strategic problem

`docs/DECENTRALIZED-INFERENCE.md` opens with the owner's framing: limiting
hardware caps both sides of the network. Image generation makes that worse, not
better.

- A 4B text model runs acceptably on CPU. **Diffusion does not.** Without a
  real GPU this is minutes per image, not seconds.
- Our own gate already says as much: `cudaEligible` requires an NVIDIA card
  with **≥ 4 GB VRAM** (`core/lib/hardware.js:87`). Most of the machines we are
  courting fail that.
- The weights are large even quantized, and they are *additional* to whatever
  text model the machine already holds.

So image generation is a feature for the top slice of our hardware
distribution. That is not a reason to skip it — it is a reason to be explicit
that it is a **capability some machines have**, exactly like the existing model
RAM gates, rather than something every user gets. The app already has the
vocabulary for this and it should be reused, not reinvented.

---

## 3. Three architectures

### Option A — bundle and manage ComfyUI as a third runtime

Fits the existing shape: `core/lib/runtimes/` already defines a swappable
adapter (`start({modelPath, …}) → {endpoint}`, `stop()`, `status()`), and
`runtime-provisioner.js` already downloads, hash-verifies and self-tests
engines.

- **For:** the whole ecosystem — LoRAs, ControlNet, upscaling, and the video
  workflows the tester mentions — arrives for free and keeps arriving.
- **Against:** we become responsible for provisioning Python + PyTorch + CUDA
  and five third-party node packs, on Windows, Linux and arm64. Every one of
  those is a support ticket we cannot fix. Install size goes up by multiple GB
  before a single weight is downloaded.

### Option B — a native diffusion engine, no Python

Something like `stable-diffusion.cpp`: a single binary, same provisioning story
as llama.cpp, hash-pinned, no Python.

- **For:** honest fit with everything we already do. Small, verifiable,
  supportable. Works on the hardware we actually have.
- **Against:** a much narrower model and feature ecosystem. No ControlNet
  ecosystem, no node graphs, and this specific Krea2/Qwen-image workflow would
  not run. Advanced users get far less.

### Option C — use ComfyUI if the user already has it

Detect a ComfyUI on `127.0.0.1:8188`, offer image generation when present, say
plainly that it is unavailable otherwise. We ship a workflow template and a
simple UI; the user owns the environment.

- **For:** near-zero dependency cost. Ships in days, not weeks. Exactly matches
  the tester's actual setup, and proves the UI and the product question before
  we buy the hard part.
- **Against:** only serves people who already run ComfyUI — a small, technical
  slice. Not a feature for a normal user yet.

---

## 4. Recommendation

**C first, then decide between A and B with evidence.**

The reason is not timidity, it is sequencing. The expensive, irreversible part
of this is the runtime dependency. The cheap, valuable part is finding out
whether a simple prompt→image surface inside Koinos AI is something people use.
Option C buys the second without paying for the first, and it is the only one
of the three that can be built while the app is still in bugfix mode.

Concretely, phase 1 is small:

- Detect a local ComfyUI, the same way the app already detects an Ollama.
- Ship the workflow as a **template with named slots** — prompt, width, height,
  seed, steps — and fill them server-side. Never let a client post a raw graph;
  that is the ComfyUI RCE surface, and the same rule the site-agent proxy
  follows for grounding blocks.
- One simple screen: prompt, format, style preset, generate. Images land in the
  user's data folder.
- Under Developer Tools (the toggle the owner already suggested), let advanced
  users point at a different workflow JSON of their own.

That last split is the owner's idea and it is the right one. Simple mode is the
product; Developer Tools is where the graph lives for people who want it.

---

## 5. Models

The workflow's active set, from the graph:

| File | Role | Notes |
|---|---|---|
| `Krea-2-Turbo-Q4_K_M.gguf` | diffusion weights | **the active one** |
| `qwen3vl_4b_fp8_scaled.safetensors` | text encoder | `CLIPLoader` type `krea2` |
| `qwen_image_vae.safetensors` | VAE | |
| `krea2_turbo_fp8.safetensors` | diffusion weights | **currently inert** (see §1) |
| `ESRGAN_4x.pth`, `Krea2-realism-V1` | upscale, LoRA | dead / disabled |

Three things to settle before any of these ship:

1. **Licence.** Every weight we distribute or auto-download needs its licence
   checked for redistribution and for commercial use. This has not been done,
   and it is a blocker, not a detail — the app is a product and the network
   settles real money.
2. **Sizes and VRAM, measured not guessed.** I have not run this and will not
   quote figures I have not seen. Ask the tester for VRAM at peak and
   seconds-per-image on their card; that single data point sets the hardware
   gate.
3. **Hash pinning.** Every model we fetch gets a `sha256` in the catalog, same
   as today (`core/lib/model-manager.js`). No exceptions for image models.

---

## 6. Two things that must NOT be decided quietly

**Moderation.** Text abuse is diffuse; image abuse is not. Image generation has
a sharp, well-known abuse profile, and Koinos AI is heading toward a public
network with paid compute on volunteer machines. Task #63 (Moderation + AUP) is
owner-DEFERRED. Image generation on the *local* app is one risk posture;
image generation **as a network job on someone else's computer** is an entirely
different one, and it should not ship on the network side until the AUP
question is reopened. Naming it here so nobody discovers it late.

**Verification.** A text job can be checked against the model's own logits.
An image cannot be verified that way — there is no cheap way to confirm a
volunteer machine actually ran the workflow rather than returning any plausible
image. Until that is answered, image generation is a LOCAL feature only. It
must not enter the paid routing path, for the same reason the producer snapshot
never reaches routing: unverified input near money is how a network gets farmed.

---

## 7. What is needed to move

From the owner:

- Which option (A, B or C), and whether image generation is local-only for now.
- Whether this displaces the current bugfix queue (#82, #83, #84, #91) or runs
  after it.

From the tester:

- Peak VRAM and seconds-per-image on their card, at 1056×1408, 8 steps.
- The Gradio front-end files, for the UI shape rather than the code.
- Confirmation that the fp8 model can be dropped from the baseline (§1).

Nothing gets built from this document until the first of those is answered.
