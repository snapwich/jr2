import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    credentials: [
      // Your repositories on GitHub. Over https://, the cluster uses the token in GITHUB_TOKEN, from .env.
      // Over ssh, it uses the deploy key in the Secret github-deploy-key.
      { match: "github.com/<you>/", token: "GITHUB_TOKEN", sshKey: "github-deploy-key" },
      // The repositories of your team on a GitLab server, over ssh only.
      { match: "gitlab.example.com/team/", sshKey: "gitlab-deploy-key" },
      // Public repositories that a run can name. No credential: the cluster clones them anonymously.
      { match: "github.com/snapwich/" },
    ],
  },
});
