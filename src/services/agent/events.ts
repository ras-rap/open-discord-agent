export type DeltaEvent = {
  type: 'message.part.delta';
  properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
};

export type PartEvent = {
  type: 'message.part.updated';
  properties: {
    sessionID: string;
    part: { id: string; type: string; tool?: string; state?: ToolState; text?: string };
  };
};

export type ToolState = { status?: string; title?: string; input?: unknown; output?: string; error?: string };

export type StatusEvent = {
  type: 'session.status';
  properties: {
    sessionID: string;
    status: { type: 'busy' } | { type: 'idle' } | { type: 'retry'; attempt: number; message: string };
  };
};

export type IdleEvent = { type: 'session.idle'; properties: { sessionID: string } };

export type PermissionAsked = {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata?: Record<string, unknown>;
    always?: string[];
    tool?: { messageID: string; callID: string };
  };
};

export type PermissionReplied = {
  type: 'permission.replied';
  properties: { sessionID: string; requestID: string; reply: string };
};

export type DiffEvent = { type: 'session.diff'; properties: { sessionID: string; diff: unknown[] } };

export type AgentEvent =
  | DeltaEvent
  | PartEvent
  | StatusEvent
  | IdleEvent
  | PermissionAsked
  | PermissionReplied
  | DiffEvent
  | { type: string; properties: Record<string, unknown> };

/**
 * The pinned 1.19.5 server emits `permission.asked` / `permission.replied`, while the published SDK
 * types still declare `permission.updated` (PLAN.md §0.1). Everything downstream consumes these
 * narrowed shapes, so a future server rename only needs editing here plus the boot self-test.
 */
export function isPermissionAsked(event: AgentEvent): event is PermissionAsked {
  return event.type === 'permission.asked';
}

export function isDelta(event: AgentEvent): event is DeltaEvent {
  return event.type === 'message.part.delta' && typeof (event as DeltaEvent).properties?.delta === 'string';
}

/** Reasoning arrives as a whole part, not as deltas, and is re-published as it grows. */
export function isReasoningPart(event: AgentEvent): event is PartEvent & { properties: { part: { text: string } } } {
  return event.type === 'message.part.updated' && (event as PartEvent).properties?.part?.type === 'reasoning';
}

export function isToolPart(event: AgentEvent): event is PartEvent {
  return event.type === 'message.part.updated' && (event as PartEvent).properties?.part?.type === 'tool';
}

export function isIdle(event: AgentEvent): event is IdleEvent | StatusEvent {
  if (event.type === 'session.idle') return true;
  return event.type === 'session.status' && (event as StatusEvent).properties?.status?.type === 'idle';
}

export type RetryEvent = {
  type: 'session.status';
  properties: { sessionID: string; status: { type: 'retry'; attempt: number; message: string } };
};

export function isRetry(event: AgentEvent): event is RetryEvent {
  return event.type === 'session.status' && (event as StatusEvent).properties?.status?.type === 'retry';
}

export type QuestionOption = { label: string; description?: string };

export type QuestionInfo = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
};

export type QuestionAsked = {
  type: 'question.asked';
  properties: {
    id: string;
    sessionID: string;
    questions: QuestionInfo[];
    tool?: { messageID: string; callID: string };
  };
};

/** The pinned server emits `question.asked`; answers go back to `POST /question/{id}/reply`. */
export function isQuestionAsked(event: AgentEvent): event is QuestionAsked {
  return event.type === 'question.asked';
}
