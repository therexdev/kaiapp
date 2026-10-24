# Verified-token inference input correction

Reviewed 2026-10-24 UTC after a Test 205 Balanced candidate report completed
29 tokenizer vectors and 12 answer measurements. Nine answers matched; this
review does not attribute those three wrong answers to the input defect or
approve a model for paid work.

## Defect and correction

The local check and network shadow/funded worker called `/tokenize` with
`add_special: false`, verified the count and token-ID hash, then sent the
rendered text to `/completion`. In pinned llama.cpp b10423, completion calls
`tokenize_input_prompts(..., true, true)`. For a string, this adds the model's
configured special tokens. For a numeric array, it preserves the supplied IDs.
Llama's rendered prompt already contains its beginning-of-text token, so the
string path inserts a duplicate after verification.

Both call sites now submit the verified numeric token array. The raw text
commitment is still validated before tokenization, and a count or ID-hash
mismatch still blocks inference. Sampling, output limits, leases, cancellation,
signatures, account isolation, and pricing are unchanged. New local report cases
include `inferenceInput` with the submitted format, count, and ID hash. The
report does not claim cryptographic attestation of the loaded weights.

Pinned upstream references:

- [Completion input handling](https://github.com/ggml-org/llama.cpp/blob/b10423/tools/server/server-context.cpp)
- [String versus numeric prompt tokenization](https://github.com/ggml-org/llama.cpp/blob/b10423/tools/server/server-common.cpp)
- [Tokenizer BOS insertion](https://github.com/ggml-org/llama.cpp/blob/b10423/src/llama-vocab.cpp)
- [Endpoint documentation](https://github.com/ggml-org/llama.cpp/blob/b10423/tools/server/README.md)

## Native vocabulary reproduction

Used the pinned b10423 Linux CPU archive, SHA-256
`664ffbf9134dbc12b2de3281d0404cb8f98a2339580911e5f74035dc320e0e84`, and the first
16,000,000 bytes of the Balanced GGUF at upstream revision
`5ab33fa94d1d04e903623ae72c95d1696f09f9e8`. That prefix's SHA-256 matched the
backend's existing source evidence:
`11d0da13a9750942c1661fcd0c9d9b61accedbcc411b038c3c3810480fde53f6`.

The prefix was copied to a sparse file sized to the published 2,019,377,696
bytes so the GGUF loader could validate tensor bounds. Only native
`llama-tokenize` vocabulary loading was used; remaining weight bytes were not
downloaded, verified, or used for inference. Each packaged Balanced prompt was
sent via stdin with `--ids --offline`, once with `--no-bos` and once with the
default special-token behavior used by completion. All 12 no-BOS counts and ID
hashes matched the packaged references. Every default result was exactly
`[128000, ...verifiedIds]`, with the verified IDs already starting with 128000.

| Case | Verified tokens | Completion-default tokenizer tokens |
| --- | ---: | ---: |
| multiplication | 50 | 51 |
| exact-word | 45 | 46 |
| json-shape | 74 | 75 |
| year-extraction | 70 | 71 |
| letter-count | 55 | 56 |
| doubling | 70 | 71 |
| ryb-colors | 77 | 78 |
| even-number | 58 | 59 |
| numeric-sort | 65 | 66 |
| context-recall | 76 | 77 |
| field-extraction | 68 | 69 |
| ordered-instructions | 57 | 58 |

The native reproduction establishes the tokenization difference, not corrected
answer quality. HTTP fixture regressions cover numeric inputs on regular and
streamed work and require the evaluated sequence to match the quote. Local
check tests bind every submitted sequence to the report. Fresh measurements on
the provider and signed network qualification remain required before admission.
