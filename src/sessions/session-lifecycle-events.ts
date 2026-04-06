export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
};

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
  // Bridge to session-lifecycle-hooks (for instinct system integration)
  // Lazy import to avoid circular dependency
  void bridgeToSessionLifecycleHooks(event);
}

async function bridgeToSessionLifecycleHooks(event: SessionLifecycleEvent): Promise<void> {
  try {
    const { emitSessionCreated, emitSessionStarted, emitSessionEnded, emitSessionError } = await import(
      "../hooks/session-lifecycle-hooks.js"
    );
    switch (event.reason) {
      case "create":
        emitSessionCreated(event.sessionKey, event.parentSessionKey, {
          label: event.label,
          displayName: event.displayName,
        });
        break;
      case "start":
        emitSessionStarted(event.sessionKey, undefined, {
          label: event.label,
          displayName: event.displayName,
        });
        break;
      case "end":
      case "yield":
      case "timeout":
      case "abort":
        emitSessionEnded(event.sessionKey, { reason: event.reason });
        break;
      case "error":
        emitSessionError(
          event.sessionKey,
          new Error(event.reason),
          { label: event.label, displayName: event.displayName }
        );
        break;
    }
  } catch {
    // Best-effort - hooks integration should not crash the caller
  }
}
