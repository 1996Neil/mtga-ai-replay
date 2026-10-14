# Add this source repository to a saved cloud environment

The source repo and the runtime data repo are different. This task does not
change GitHub connector permissions, add secrets, edit the saved environment,
republish it or deploy the application.

For the existing `NeilCloud` configuration, open **Settings > Codex Cloud >
Environments**, choose its **… > Edit**, and request addition of this private
source repository. Use Node 24.x. If it is not offered in the repository picker,
the user must grant the GitHub connection access to this specific repository;
do not widen account access automatically.

Installation/check commands from the repository root:

```bash
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix viewer
npm test
npm run viewer:test
npm run viewer:build
npm run test:cloud
npm run check:release
```

Review the setup report, save and **Republish** the environment. Start a new task
from the updated environment; existing tasks retain their prior saved files.
The official OpenAI documentation describes this saved-state behavior:
https://learn.chatgpt.com/docs/environments/cloud-environments

Do not add GPT/TTS credentials or private runtime data for this source setup.
The complete Viewer suite and production build use the 19 hash-pinned files included in private PR #3 under explicit user authorization. This does not establish an upstream license or public redistribution rights. `npm start` is only a disposable synthetic API, not a real-time Mac log collector.
