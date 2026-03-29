# Contributing to helix-agent

## Development Setup

```bash
git clone https://github.com/oaslananka/helix-agent
cd helix-agent
cp .env.example .env
npm install
npm run dev &
```

## Adding a New Core Tool

1. Create `src/tools/domain/myTool.ts`
2. Implement the `createTool()` factory
3. Register in `src/index.ts`
4. Add tests in `test/`

## Adding a Plugin

1. Create `plugins/my-plugin/manifest.json`
2. Create `plugins/my-plugin/index.js`
3. Test with `npm run dev &`

## Code Standards

- TypeScript strict mode — no `any`
- All errors must be typed (`HelixAgentError` subclass)
- All async tool operations must have timeouts
- New tools require unit tests

## Running Tests

```bash
npm test              # All tests
npm test -- --watch   # Watch mode
npm test -- --coverage
```
