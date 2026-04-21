# Release Checklist

Before publishing or pushing a release:

1. Run the local verification commands:

   ```bash
   npm test
   npm run typecheck
   npm run build
   npm pack --dry-run
   ```

2. Ask Claude Code to independently review and test the repository.

3. Keep `README.md` English-first. Put Chinese documentation in `README.zh-CN.md` or another separate Chinese file.

4. Fix any blocking findings from that review.

5. Push only after the local checks and Claude Code review both pass.
