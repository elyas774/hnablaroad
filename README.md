# طريق الحنابلة

This repository contains the currently deployed Netlify snapshot for the existing site. The `index.html` file is the deployment bundle rather than the original editable source tree.

## Netlify deployment

- Publish directory: repository root (`.`)
- Functions directory: `netlify/functions`
- The `generate-exam` function uses the `OPENAI_API_KEY` environment variable. Keep that value in Netlify environment settings; never commit it here.

The deployed `index.html` was verified against the live site before this snapshot was added.
