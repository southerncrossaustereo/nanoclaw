## GitHub CLI (`gh`)

You have access to the GitHub CLI authenticated as a **GitHub App** (bot identity). The `GH_TOKEN` environment variable is pre-configured with an installation token that expires after 1 hour.

Usage examples:
```bash
gh repo list                          # list repositories
gh issue list -R owner/repo           # list issues
gh pr list -R owner/repo              # list pull requests
gh api /repos/owner/repo              # raw API calls
```

### Token expiry

If `gh` commands fail with 401/403 errors, the token may have expired. Use the `refresh_github_token` MCP tool to get a new one, then apply it:
```bash
export GH_TOKEN=<token from refresh_github_token>
```
