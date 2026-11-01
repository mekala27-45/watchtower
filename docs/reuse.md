# Reuse record

No Handoff source code was copied. The prompt identified inherited candidate commit 351f01a53890b1530616e76e72b24a082a37152a. Fetching package.json for that exact ref from mekala27-45/handoff returned no commit found on 2026-11-01. The reusable helpers therefore remain uninspected; the candidate implements its contracts independently.

The inherited package numbers remain candidates in dependency-lock.json. They are not installed versions or compatibility claims. The local implementation uses Node built-in modules to make the reversible implementation testable with the available runtime. Native JavaScript and SQLite are declared deviations from the TypeScript and Postgres target.

