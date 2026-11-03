# Watchtower Day 23 release

Watchtower captures bounded release metadata, checks typed differences, freezes evidence for review and recovers an internal publication receipt after a lost response.

The public application is https://mekala27-45.github.io/watchtower/. Its API uses direct TLS Postgres at https://watchtower-mekala27-45s-projects.vercel.app. The Pages browser passed all 9 checks, including digest-bound review, identical receipt recovery and a separate client seeing exactly one receipt.

The deterministic baseline matched 42 of 42 expected findings across 72 held-out sequences. The separate actual local model attempted 24 sequences, completed 20 and retained 4 failures. It produced zero supported proposals and missed all 13 expected findings. The useful-model criterion did not pass. Original inference evidence remains unchanged.

A fresh checkout of implementation revision 05ec1ac5044a84e8f52796fad26275157a9fc01d passed 160 tests without failures or skips. Both recovery matrices passed all 541 applicable cases, with 35 cases not applicable. The Postgres matrix includes 109 real process terminations. Fourteen local compiled browser checks also passed. The database was proved empty before the checked-in migrations were applied. An initial unmigrated setup failure is retained separately.

Manual Actions collection run 41666485561 succeeded. Eight independent database assertions verified 8 HTTP attempts and 4 partial captures, with no false usable comparison head. Recurring collection is enabled at minute 17 every six hours UTC. No scheduled run is claimed.

This source snapshot is prepared before final publication. The final annotated release tag, source archive digest and observed public release are recorded in post-publication verification. Later evidence-only documentation does not amend the released tag or imply another model run.

Read RESULTS.md for separate baseline and actual-model tables. Open reports/browser/pages-demo.gif for the actual screenshot sequence and pages-demo.json for frame provenance.
