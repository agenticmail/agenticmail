# Contributing to AgenticMail

Thank you for your interest in contributing to AgenticMail! This guide will help
you get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Standards](#code-standards)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)

## Development Setup

### Prerequisites

- **Node.js** 20 or later
- **npm** 10 or later
- **Docker** (for running the Stalwart mail server)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/agenticmail/agenticmail.git
cd agenticmail

# Install dependencies
npm install

# Start the Stalwart mail server
docker compose up -d

# Build all packages
npm run build

# Run tests
npm test
```

## Project Structure

AgenticMail is a TypeScript monorepo with npm workspaces:

```
packages/
  core/       - @agenticmail/core    (SDK: IMAP, SMTP, accounts, gateway, spam filter)
  api/        - @agenticmail/api     (Express REST API server)
  mcp/        - @agenticmail/mcp     (MCP server for Claude Code / Claude Desktop)
  openclaw/   - @agenticmail/openclaw (OpenClaw plugin and skill)
agenticmail/  - agenticmail           (CLI facade package)
```

### Package Dependencies

```
agenticmail (CLI) ─> @agenticmail/api ─> @agenticmail/core
@agenticmail/mcp (standalone — makes HTTP calls to the API)
@agenticmail/openclaw (standalone — makes HTTP calls to the API)
```

## Code Standards

### TypeScript

- **Strict TypeScript** — avoid `any` types where possible
- **ES Modules** — all packages use `"type": "module"` with `.js` extensions in imports
- **No default exports** — use named exports for better IDE support

### Style

- 2-space indentation
- Single quotes for strings
- Semicolons required
- No trailing commas in function parameters

### Conventions

- Use `camelCase` for variables and functions
- Use `PascalCase` for classes, interfaces, and type aliases
- Prefix interfaces with descriptive names (e.g., `GatewayConfig`), not `I`
- Keep files focused — one primary export per file

## Making Changes

### Branch Naming

- `feature/description` — new features
- `fix/description` — bug fixes
- `docs/description` — documentation changes

### Commit Messages

Write clear, concise commit messages:

```
Add spam filter scoring for relay inbound emails

- Score all relay emails unconditionally (always external)
- Skip internal agent-to-agent emails
- Move spam to Spam folder via IMAP
```

### Guidelines

- **Keep changes focused** — one feature or fix per PR
- **Small diffs preferred** — easier to review and less likely to introduce bugs
- **Don't mix refactoring with features** — separate PRs for each

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests for a specific package
cd packages/core && npx vitest run

# Run tests in watch mode
cd packages/core && npx vitest
```

### Test Requirements

- New features must include tests
- Bug fixes should include a regression test
- Tests use [Vitest](https://vitest.dev/)

### Building

```bash
# Build all packages
npm run build

# Build a specific package
cd packages/core && npx tsup src/index.ts --format esm --dts --clean
```

## Pull Request Process

1. **Fork** the repository and create your branch from `main`
2. **Write code** following the standards above
3. **Add tests** for new functionality
4. **Build** all packages: `npm run build`
5. **Run tests**: `npm test`
6. **Submit** a pull request with a clear description

### PR Checklist

- [ ] Code builds without errors (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] New features have tests
- [ ] Commit messages are clear and descriptive
- [ ] No unrelated changes included

## Questions?

- Open an [issue](https://github.com/agenticmail/agenticmail/issues) for bugs or feature requests
- Check existing issues before creating new ones
- Reach out to the maintainer via [GitHub](https://github.com/ope-olatunji)

Thank you for contributing!
