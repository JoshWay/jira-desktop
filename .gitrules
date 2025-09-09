# Git Workflow Rules for LLM Assistants

## Branch Structure & Purpose

### `main` (Production)
- **Purpose**: Stable, deployable code only
- **Protection**: Protected branch - no direct commits
- **Updates**: Only via PR/merge from `dev` after testing
- **LLM Rule**: Never suggest direct commits to main

### `dev` (Integration)
- **Purpose**: Integration branch for all feature work
- **Usage**: All feature branches merge here first
- **Testing**: QA and staging testing happens from dev
- **LLM Rule**: Merge features here before suggesting main merge

### `feature/<name>` (Feature Development)
- **Purpose**: Isolated development of specific features
- **Naming**: `feature/authentication`, `feature/user-dashboard`, etc.
- **Lifecycle**: Create → Develop → Test → Merge to dev → Delete
- **LLM Rule**: One branch per logical feature or task

## Workflow Commands for LLMs

### Creating New Features
```bash
# Always start from dev
git checkout dev
git pull origin dev
git checkout -b feature/feature-name
```

### Working on Features
```bash
# Regular development cycle
git add .
git commit -m "feat: descriptive commit message"
git push origin feature/feature-name
```

### Merging Features
```bash
# Merge to dev first
git checkout dev
git merge feature/feature-name
git push origin dev

# Clean up
git branch -d feature/feature-name
git push origin --delete feature/feature-name
```

### Promoting to Production
```bash
# Only after dev is tested and stable
git checkout main
git merge dev
git push origin main
```

## LLM Assistant Rules

### When to Suggest Branch Changes
1. **New Feature**: Create `feature/<name>` branch
2. **Bug Fix**: Create `hotfix/<name>` branch (merges to both dev and main)
3. **Integration Testing**: Use `dev` branch
4. **Production Release**: Use `main` branch

### What NOT to Suggest
- Direct commits to `main` branch
- Pushing untested code to `dev`
- Working directly on `dev` for features
- Deleting branches with unmerged work

### Commit Message Format
```
type: short description

- feat: new feature
- fix: bug fix
- docs: documentation
- style: formatting
- refactor: code restructuring
- test: adding tests
- chore: maintenance
```

## Worktree Management

### Standard Worktree Structure
```
project-name/          # main branch (stable)
project-name-dev/      # dev branch (integration)
project-name-feature/  # current feature work
```

### LLM Worktree Commands
```bash
# Create dev worktree
git worktree add ../project-name-dev dev

# Create feature worktree
git worktree add ../project-name-feature feature/current-work

# List all worktrees
git worktree list

# Remove completed worktree
git worktree remove ../project-name-feature
```

## Safety Checks for LLMs

Before suggesting any Git operation, verify:
1. Current branch is appropriate for the task
2. Working directory is clean (`git status`)
3. Latest changes are pulled (`git pull`)
4. Target branch exists and is up to date

## Common Scenarios

### Starting New Feature Work
1. Ensure in dev worktree: `cd ../project-name-dev`
2. Pull latest: `git pull origin dev`
3. Create feature branch: `git checkout -b feature/new-feature`
4. Create feature worktree: `git worktree add ../project-name-feature feature/new-feature`

### Code Review Ready
1. Push feature branch: `git push origin feature/branch-name`
2. Suggest creating PR to dev branch
3. Do not merge automatically

### Emergency Hotfix
1. Create from main: `git checkout main && git checkout -b hotfix/urgent-fix`
2. Fix and test
3. Merge to both main and dev
4. Tag the release

## Integration with .agent-os and .claude

- These configuration files should exist in main branch
- Feature branches inherit them automatically
- Worktrees share the same .git directory, so configurations persist
- Always commit config changes to appropriate branch first

## Questions to Ask Before Git Operations

1. "What branch should this work be done on?"
2. "Have you pulled the latest changes?"
3. "Is this ready for integration testing?"
4. "Should this go to main or dev first?"
5. "Do you want me to create a new worktree?"