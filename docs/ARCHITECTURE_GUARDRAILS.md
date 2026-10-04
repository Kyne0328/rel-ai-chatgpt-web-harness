# Architecture Guardrails

## Purpose

These rules keep Rel.AI maintainable as responsibilities grow. They are intentionally small: they prevent ownership drift without creating a second framework.

## Ownership rules

### ChatGPT/client layer

Owns:
- reasoning
- conversation context
- deciding when to request tools

Does not own:
- repository state
- process lifecycle
- durable task authority
- local permissions

### Rel.AI core

Owns:
- execution
- authorization
- workspace boundaries
- lifecycle authority
- durable state

Does not own:
- dashboard rendering
- Electron UI concerns
- browser credential decisions

### Dashboard/UI

Owns:
- presentation
- interaction state
- visual projections

Does not own:
- task completion
- process state
- filesystem authority
- MCP protocol decisions

### Desktop/Electron

Owns:
- OS integration
- windows
- updater
- secure IPC
- tunnel lifecycle

Does not own:
- repository operations
- task semantics

## Before adding a new subsystem

Answer these questions:

1. What existing owner should contain this responsibility?
2. Is this state authoritative or derived?
3. Can an existing event/projection represent this instead?
4. Does this introduce another lifecycle?
5. Does this add a new source of truth?

A new source of truth requires an explicit architecture review.

## Avoid duplication

Do not add:

- another task tracker
- another memory database
- another workflow engine
- another UI synchronization channel
- another compatibility layer without a verified client requirement

Prefer extending the existing owner.
