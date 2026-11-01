# Third party notices

The original implementation is MIT licensed. Original authored temporal fixtures and their truth records are dedicated under CC0-1.0 in `fixtures/LICENSE.txt`.

The dependency versions below were read from installed package metadata. `package-lock.json` records the complete dependency graph, resolved archives and integrity values. Transitive dependencies retain their own notices and licenses in the installed packages. The container preserves installed package license files.

| Package | Version | Declared license |
| --- | --- | --- |
| eve | 1.0.0-rc.1 | Apache-2.0 |
| ai | 7.0.159 | Apache-2.0 |
| @ai-sdk/openai-compatible | 3.0.82 | Apache-2.0 |
| pg | 8.23.1 | MIT |
| zod | 4.6.7 | MIT |
| TypeScript | 7.0.2 | Apache-2.0 |
| Vite | 8.3.5 | MIT |
| @playwright/test | 1.64.1 | Apache-2.0 |
| @fontsource/bodoni-moda | 5.3.0 | OFL-1.1 |
| @fontsource/noto-sans | 5.3.0 | OFL-1.1 |
| @fontsource/fira-mono | 5.3.0 | OFL-1.1 |

The bundled Latin font files are unmodified Fontsource assets. Their license texts and file digests are in `apps/site/fonts/`. The build copies the notices and provenance into `dist/site/licenses/` for public distribution. Bodoni Moda, Noto Sans and Fira Mono remain subject to the SIL Open Font License 1.1.

Node 24.19.0, its bundled SQLite, the Debian container base and their bundled components retain upstream licenses. The immutable image manifest is recorded in `reports/probes/container-image.json`. The Qwen3 0.6B model is identified as Apache-2.0 in `reports/probes/ollama-model.json`; the report records the exact Ollama artifact and runtime archive digests. Model weights and the Ollama runtime archive are not included in this repository or the public container.

No release-note body, account profile or downloaded model binary is redistributed. The collector stores admitted factual metadata, with a digest and byte count of note text. Public availability does not establish a license to republish upstream prose.

The Day 23 prompt supplies the requested design. Handoff implementation was not copied. See `docs/reuse.md` for the bounded reuse record.
