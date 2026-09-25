// Hook ingress: what each harness posts to /hooks/claude, /hooks/codex and /hooks/muse, and
// what cophylad answers. The Claude Code shapes were read off the wire in spikes 02 and 03; the
// Codex shapes off the wire in milestone 1 (Codex hooks are Claude-shaped: PascalCase event
// names on the wire, camelCase in the app-server's `hooks/list` metadata). See
// architecture.md, "Hook ingress". Muse Code's, Claude-shaped too, in milestone 18.

import { z } from "zod";

// ---------------------------------------------------------------------------------------
// Claude Code

export const ClaudeHookEventName = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Elicitation",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
]);
export type ClaudeHookEventName = z.infer<typeof ClaudeHookEventName>;

export const ClaudePermissionMode = z.enum(["default", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);

/** Every Claude Code hook event. Fields past the common four depend on the event. */
export const ClaudeHookEvent = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  hook_event_name: ClaudeHookEventName,
  permission_mode: z.string().optional(),
  prompt_id: z.string().optional(),
  // UserPromptSubmit
  prompt: z.string().optional(),
  // PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  error: z.string().optional(),
  permission_suggestions: z.array(z.unknown()).optional(),
  // Notification
  message: z.string().optional(),
  notification_type: z.string().optional(),
  // Stop, SubagentStop
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
  // SessionStart, SessionEnd, PreCompact
  source: z.string().optional(),
  reason: z.string().optional(),
  trigger: z.string().optional(),
  session_title: z.string().optional(),
  model: z.string().optional(),
  scratchpad_dir: z.string().optional(),
});
export type ClaudeHookEvent = z.infer<typeof ClaudeHookEvent>;

export const ClaudePermissionDecision = z.object({
  behavior: z.enum(["allow", "deny"]),
  message: z.string().optional(),
  updatedInput: z.unknown().optional(),
});

/** What cophylad answers. `{}` for events it only records. */
export const ClaudeHookResponse = z.object({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  hookSpecificOutput: z
    .object({
      hookEventName: ClaudeHookEventName,
      // PermissionRequest
      decision: ClaudePermissionDecision.optional(),
      // PreToolUse
      permissionDecision: z.enum(["allow", "deny", "ask"]).optional(),
      permissionDecisionReason: z.string().optional(),
      // UserPromptSubmit, SessionStart
      additionalContext: z.string().optional(),
    })
    .optional(),
});
export type ClaudeHookResponse = z.infer<typeof ClaudeHookResponse>;

// ---------------------------------------------------------------------------------------
// Codex. The wire uses PascalCase names; `hooks/list` on the app-server reports camelCase.

export const CodexHookEventName = z.enum([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
  "interrupt",
]);
export type CodexHookEventName = z.infer<typeof CodexHookEventName>;

/** A Codex hook event as piped to the command hook's stdin. `session_id` is the thread id. */
export const CodexHookEvent = z.object({
  hook_event_name: CodexHookEventName,
  session_id: z.string(),
  turn_id: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  /** The rollout file; null before the thread has one. */
  transcript_path: z.string().nullable().optional(),
  // SessionStart, SessionEnd
  source: z.string().optional(),
  reason: z.string().optional(),
  // UserPromptSubmit
  prompt: z.string().optional(),
  // PermissionRequest, PostToolUse
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  // Stop
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
});
export type CodexHookEvent = z.infer<typeof CodexHookEvent>;

/**
 * What cophylad answers a Codex hook: Claude's shape. `{}` is no decision. Anything else
 * (`interrupt`, `updatedInput`, `updatedPermissions`, `continue: false`, `stopReason`,
 * `suppressOutput`) fails closed on the Codex side and is never sent.
 */
export const CodexHookResponse = z.object({
  continue: z.boolean().optional(),
  hookSpecificOutput: z
    .object({
      hookEventName: CodexHookEventName,
      decision: z.object({ behavior: z.enum(["allow", "deny"]), message: z.string().optional() }).optional(),
      additionalContext: z.string().optional(),
    })
    .optional(),
});
export type CodexHookResponse = z.infer<typeof CodexHookResponse>;

// ---------------------------------------------------------------------------------------
// Muse Code. Its hooks come only through a plugin, and fire in the TUI, never under
// `muse serve`. The events are Claude-shaped, read off the wire in milestone 18.

export const MuseHookEventName = z.enum([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PreLLMCall",
  "PostLLMCall",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "Stop",
  "StopFailure",
  "Interrupt",
]);
export type MuseHookEventName = z.infer<typeof MuseHookEventName>;

/**
 * A Muse hook event as piped to the plugin hook's stdin. `session_id` is a root session's
 * UUIDv7, or a reminder or subagent child's own id; `transcript_path` is always null.
 */
export const MuseHookEvent = z.object({
  hook_event_name: MuseHookEventName,
  session_id: z.string(),
  turn_id: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  model_provider: z.string().optional(),
  permission_mode: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  // SessionStart, SessionEnd
  source: z.string().optional(),
  reason: z.string().optional(),
  // UserPromptSubmit
  prompt: z.string().optional(),
  // PermissionRequest, PostToolUse, PostToolUseFailure
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  // Notification
  message: z.string().optional(),
  // Stop, SubagentStop
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  // SubagentStart, SubagentStop
  child_session_id: z.string().optional(),
  subagent_id: z.string().optional(),
});
export type MuseHookEvent = z.infer<typeof MuseHookEvent>;

/** What cophylad answers a Muse hook: Claude's PermissionRequest shape with `behavior` and `message` alone, or `{}`. */
export const MuseHookResponse = z.object({
  hookSpecificOutput: z
    .object({
      hookEventName: MuseHookEventName,
      decision: z.object({ behavior: z.enum(["allow", "deny"]), message: z.string().optional() }).optional(),
    })
    .optional(),
});
export type MuseHookResponse = z.infer<typeof MuseHookResponse>;

export const hooks = {
  claude: { event: ClaudeHookEvent, response: ClaudeHookResponse },
  codex: { event: CodexHookEvent, response: CodexHookResponse },
  muse: { event: MuseHookEvent, response: MuseHookResponse },
} as const;
