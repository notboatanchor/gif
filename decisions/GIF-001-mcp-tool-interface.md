# GIF-001 — MCP as Sole Tool Interface

**Status:** Accepted  
**Date:** 2026-04-04

## Decision

The MCP server is the single interface between AI models and all tools. Tool dispatch is registry-driven. The model operates within access that already exists — it does not grant access.

## Context

AI governance requires a consistent enforcement point. Without one, authorization logic is distributed across tool implementations, application code, and calling conventions — each of which can be bypassed independently. The framework needs a single chokepoint where every tool call is visible and interceptable before execution.

## Rationale

- Hardwired tool calls do not scale to multi-tool or model-driven orchestration. A registry-driven model decouples capability registration from enforcement logic.
- A single enforcement chokepoint enables consistent audit logging for every tool call regardless of which tool is invoked. There is no path to tool execution that bypasses the record.
- New capabilities are added to the registry without changing the model interface or the enforcement path. The enforcement engine contains no knowledge of which specific tools exist.
- The AI identifies which persona is appropriate for a task and which tools to call. GIF validates that the persona is active and that the requested action falls within its declared scope. The model does not determine its own authorization — it operates within access that already exists.

## Consequences

All enforcement, audit, and persona scope validation happen at the MCP layer. Tools added to the registry are automatically subject to enforcement without code changes to the enforcement engine. No hardwired tool calls are permitted anywhere in the framework or in conforming adopter implementations.
