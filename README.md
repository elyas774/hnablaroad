# طريق الحنابلة

This repository contains the currently deployed Netlify snapshot for the existing site. The `index.html` file is the deployment bundle rather than the original editable source tree.

## Netlify deployment

- Publish directory: repository root (`.`)
- Functions directory: `netlify/functions`
- The `generate-exam` function uses the `OPENAI_API_KEY` environment variable. Keep that value in Netlify environment settings; never commit it here.

The deployed `index.html` was verified against the live site before this snapshot was added.

## Isolated preview work

- The trial changes for smart learning, exam review, and vacation rules are on `preview/smart-learning-vacation`.
- `main` remains the production branch. Do not merge this preview branch until its tests and user review are complete.
- Netlify branch deploys are configured for this branch only; confirm the branch build in Netlify Deploys before treating it as a live preview.
- Run the synthetic checks with `node --test tests/preview-invariants.test.cjs` and syntax-check the function with `node --check netlify/functions/generate-exam.js`.
- The tests do not call Firebase or OpenAI and do not use real student records.
