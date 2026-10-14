import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    credentials: [
      // Your Repos. The token clones and pushes. The key in the Secret jr2-git-sign signs the commits.
      {
        match: "github.com/<you>/",
        token: "JR2_GIT_TOKEN",
        sign: { sshKey: "jr2-git-sign", name: "<your name>", email: "<your email>" },
      },
      // The entry that jr2 init writes, for each other Repo.
      { match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" },
    ],
  },
});
