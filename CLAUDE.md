## Orchestra dispatch protocol

This project is managed by the Orchestra daemon. At the end of every working session:

1. **Update `docs/PROJECT_TRACKER.md`** — set `current_stage:` to the next stage key and write its `prompt:` describing what the next agent should do. If there is no next step yet, set `status: paused`.
2. **Update `STATUS.md`** with what was done and what's next.

`current_stage` must exactly match a key under `stages:` in the tracker frontmatter, or Orchestra will skip this project. Set `status: active` when ready for the daemon to dispatch; leave `status: paused` until then.
