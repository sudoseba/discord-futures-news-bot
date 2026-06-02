# CI workflow template

GitHub blocks Personal Access Tokens without `workflow` scope from creating or
updating files under `.github/workflows/`. The initial repo push used such a
token, so the CI workflow was parked here instead.

To enable CI:

```bash
# 1. Generate a new PAT with both repo + workflow scopes (or use a fine-grained
#    token that grants "Actions: read & write" on this repository).
# 2. Copy the workflow into place:
mkdir -p .github/workflows
cp docs/ci-template/ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions workflow"
git push
```

The workflow runs `vitest` and a module-load smoke test on every push and PR
against `main`.
