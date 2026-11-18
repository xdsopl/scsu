### SCSU for the browser

A small WebAssembly module that converts between UTF-8 and SCSU, the Standard Compression Scheme for Unicode ([UTS #6](https://www.unicode.org/reports/tr6/)). SCSU needs about one byte per character for alphabetic scripts (Cyrillic, Greek, Arabic, Hebrew, Indic, Thai and others) and about two for CJK, while covering all of Unicode. Rattlechan uses it as its Text-SCSU type. Like CRYPTO and HYDRA, it needs no libc and no JavaScript glue code.

**Try it:** https://xdsopl.github.io/scsu/ shows the sizes of any text you type and runs the test suite in your browser: known answers from ICU, samples in 14 scripts, malformed input, random strings, the largest input and the timings.

## Interface

### Buffers
* **`text`** ($2^{22}$ bytes): UTF-8 text, the input of `scsu_encode` and the output of `scsu_decode`.
* **`scsu`** ($2^{22}$ bytes): SCSU bytes, the output of `scsu_encode` and the input of `scsu_decode`.

### Functions
* **`scsu_encode(tlen)`:** compresses the first `tlen` bytes of `text` into `scsu` and returns the number of bytes written. Returns `-1` for invalid UTF-8 (overlong forms, surrogates, code points above U+10FFFF) or `tlen` out of range.
* **`scsu_decode(slen)`:** expands the first `slen` bytes of `scsu` into UTF-8 in `text` and returns its length. Returns `-1` for reserved tags, undefined window offsets, truncated input or unpaired surrogates, so `text` always holds valid UTF-8.

### Limits
* **Input length:** at most $2^{20}$ bytes for either function. The buffers are four times larger, since neither direction expands by more than a factor of four.
* **Memory:** about 12 MiB of WebAssembly memory, which never grows.

## Encoder

SCSU leaves the encoder free to choose its windows, so different encoders produce different bytes for the same text; every conforming decoder reads them all. This encoder looks one character ahead: it switches windows or modes only for runs, quotes single characters, uses the static windows for isolated punctuation and replaces the least recently used window when it defines a new one.

## Testing

`make check` builds the module and a native shared library, then:
* cross-checks against ICU's SCSU converter: each side decodes the other's output, for 16 scripts and 20000 random strings across all planes, including private use and supplementary characters,
* feeds malformed and random bytes to the decoder,
* round-trips samples through the WebAssembly build in Node.js.

`make webserver` serves `docs/` on http://127.0.0.1:8080/ to run the browser tests against your local build.

The checks need gcc, clang with wasm-ld, Node.js and ICU's `libicuuc` (any version).

Sizes in bytes for the sample sentences of the test, compared with UTF-8 and ICU's encoder:

| Script | UTF-8 | SCSU | ICU |
|---|---:|---:|---:|
| English | 47 | 47 | 47 |
| German | 60 | 53 | 53 |
| Russian | 85 | 50 | 50 |
| Greek | 77 | 45 | 45 |
| Arabic | 62 | 35 | 35 |
| Hindi | 95 | 38 | 38 |
| Bengali | 109 | 44 | 44 |
| Tamil | 148 | 56 | 56 |
| Thai | 79 | 29 | 29 |
| Japanese | 75 | 38 | 38 |
| Chinese | 69 | 47 | 47 |
| Korean | 54 | 45 | 45 |

## License

Copyright (C) 2026 Ahmet Inan. Released under the 0BSD license, see [LICENSE](LICENSE).
