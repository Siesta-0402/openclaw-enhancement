/**
 * OpenClaw Session Lifecycle Hooks System
 * 
 * This module provides hooks for session lifecycle events, allowing
 * external code to be notified when sessions start, end, or transition
 * between states.
 * 
 * Use cases:
 * - Logging session activity
 * - Tracking session duration
 * - Notifying external services on session events
 * - Implementing session-based resource cleanup
 * - Building session analytics
 */

import { BashVerificationBehavior, PermissionResult, ValidationContext } from '../agents/bash-verification.js';

// ============================================================================
// Session Lifecycle Types
// ============================================================================

export type SessionEventType =
  | 'session:created'
  | 'session:started'
  | 'session:paused'
  | 'session:resumed'
  | 'session:yielded'
  | 'session:continued'
  | 'session:ended'
  | 'session:error'
  | 'session:timeout'
  | 'session:aborted';

export interface SessionEvent {
  type: SessionEventType;
  sessionKey: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  parentSessionKey?: string;
  depth?: number;
}

export interface LifecycleHook {
  id: string;
  name: string;
  eventTypes: SessionEventType[];
  handler: (event: SessionEvent) => void | Promise<void>;
  filter?: (event: SessionEvent) => boolean;
  priority?: number;
  enabled?: boolean;
}

export interface HookRegistration {
  id: string;
  hooks: LifecycleHook[];
}

export interface SessionState {
  sessionKey: string;
  status: 'pending' | 'active' | 'paused' | 'yielded' | 'ended';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt: number;
  eventCount: number;
  metadata: Record<string, unknown>;
}

// ============================================================================
// Hook System
// ============================================================================

class SessionLifecycleHooks {
  private hooks: Map<string, LifecycleHook> = new Map();
  private sessionStates: Map<string, SessionState> = new Map();
  private eventQueue: SessionEvent[] = [];
  private processing = false;
  private maxQueueSize = 1000;

  /**
   * Register a lifecycle hook.
   */
  register(hook: LifecycleHook): () => void {
    if (!hook.id) {
      hook.id = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    
    this.hooks.set(hook.id, hook);
    
    // Return unregister function
    return () => this.unregister(hook.id);
  }

  /**
   * Unregister a hook by ID.
   */
  unregister(hookId: string): boolean {
    return this.hooks.delete(hookId);
  }

  /**
   * Get all registered hooks.
   */
  getHooks(): LifecycleHook[] {
    return Array.from(this.hooks.values());
  }

  /**
   * Get hooks for a specific event type.
   */
  getHooksForEvent(eventType: SessionEventType): LifecycleHook[] {
    return Array.from(this.hooks.values())
      .filter(h => h.enabled !== false && h.eventTypes.includes(eventType))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Emit a session event.
   */
  async emit(event: SessionEvent): Promise<void> {
    // Queue event for processing
    if (this.eventQueue.length >= this.maxQueueSize) {
      this.eventQueue.shift(); // Drop oldest
    }
    this.eventQueue.push(event);
    
    // Process asynchronously
    this.processQueue();
  }

  /**
   * Process the event queue.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    
    try {
      while (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        await this.handleEvent(event);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Handle a single event.
   */
  private async handleEvent(event: SessionEvent): Promise<void> {
    const hooks = this.getHooksForEvent(event.type);
    
    for (const hook of hooks) {
      try {
        // Check filter if present
        if (hook.filter && !hook.filter(event)) {
          continue;
        }
        
        // Execute handler
        await hook.handler(event);
      } catch (error) {
        console.error(`Hook ${hook.id} error:`, error);
      }
    }
  }

  /**
   * Create or update session state.
   */
  updateSessionState(sessionKey: string, updates: Partial<SessionState>): void {
    const existing = this.sessionStates.get(sessionKey);
    
    if (existing) {
      this.sessionStates.set(sessionKey, {
        ...existing,
        ...updates,
        lastEventAt: Date.now(),
        eventCount: existing.eventCount + 1,
      });
    } else {
      this.sessionStates.set(sessionKey, {
        sessionKey,
        status: 'pending',
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        eventCount: 1,
        metadata: {},
        ...updates,
      });
    }
  }

  /**
   * Get session state.
   */
  getSessionState(sessionKey: string): SessionState | undefined {
    return this.sessionStates.get(sessionKey);
  }

  /**
   * Get all session states.
   */
  getAllSessionStates(): SessionState[] {
    return Array.from(this.sessionStates.values());
  }

  /**
   * Clear old session states.
   */
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleared = 0;
    
    for (const [key, state] of this.sessionStates) {
      if (state.lastEventAt < cutoff) {
        this.sessionStates.delete(key);
        cleared++;
      }
    }
    
    return cleared;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const sessionLifecycleHooks = new SessionLifecycleHooks();

// ============================================================================
// Pre-built Hooks
// ============================================================================

/**
 * Create a logging hook that logs all events.
 */
export function createLoggingHook(options: {
  prefix?: string;
  includeMetadata?: boolean;
  minLevel?: 'debug' | 'info' | 'warn' | 'error';
} = {}): LifecycleHook {
  const { prefix = '[SessionLifecycle]', includeMetadata = false, minLevel = 'info' } = options;
  
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const minLevelNum = levels[minLevel];
  
  return {
    id: 'logging_hook',
    name: 'Session Lifecycle Logger',
    eventTypes: [
      'session:created',
      'session:started',
      'session:paused',
      'session:resumed',
      'session:yielded',
      'session:continued',
      'session:ended',
      'session:error',
      'session:timeout',
      'session:aborted',
    ],
    priority: 0,
    handler: (event: SessionEvent) => {
      const logLevel = event.type.includes('error') || event.type.includes('abort') ? 'error' 
        : event.type.includes('timeout') ? 'warn'
        : 'info';
      
      if (levels[logLevel] >= minLevelNum) {
        const parts = [`${prefix} ${event.type}`, `session=${event.sessionKey}`];
        
        if (event.parentSessionKey) {
          parts.push(`parent=${event.parentSessionKey}`);
        }
        
        if (event.depth !== undefined) {
          parts.push(`depth=${event.depth}`);
        }
        
        if (includeMetadata && event.metadata) {
          parts.push(`meta=${JSON.stringify(event.metadata)}`);
        }
        
        const logFn = logLevel === 'error' ? console.error 
          : logLevel === 'warn' ? console.warn 
          : console.log;
        
        logFn(parts.join(' | '));
      }
    },
  };
}

/**
 * Create a session duration tracking hook.
 */
export function createDurationTrackingHook(): LifecycleHook {
  const durations = new Map<string, number>();
  
  return {
    id: 'duration_tracking_hook',
    name: 'Session Duration Tracker',
    eventTypes: ['session:created', 'session:started', 'session:ended'],
    priority: 0,
    handler: (event: SessionEvent) => {
      switch (event.type) {
        case 'session:created':
          sessionLifecycleHooks.updateSessionState(event.sessionKey, { status: 'pending' });
          break;
        case 'session:started':
          sessionLifecycleHooks.updateSessionState(event.sessionKey, { 
            status: 'active',
            startedAt: event.timestamp 
          });
          break;
        case 'session:ended':
          const state = sessionLifecycleHooks.getSessionState(event.sessionKey);
          if (state?.startedAt) {
            const duration = event.timestamp - state.startedAt;
            durations.set(event.sessionKey, duration);
          }
          sessionLifecycleHooks.updateSessionState(event.sessionKey, {
            status: 'ended',
            endedAt: event.timestamp
          });
          break;
      }
    },
  };
}

/**
 * Create a hook that emits events to an external endpoint.
 */
export function createExternalNotifierHook(options: {
  url: string;
  headers?: Record<string, string>;
  includeMetadata?: boolean;
  eventTypes?: SessionEventType[];
}): LifecycleHook {
  return {
    id: 'external_notifier_hook',
    name: 'External Event Notifier',
    eventTypes: options.eventTypes || [
      'session:created',
      'session:ended',
      'session:error',
    ],
    priority: -100, // Run last
    handler: async (event: SessionEvent) => {
      try {
        const body: Record<string, unknown> = {
          type: event.type,
          sessionKey: event.sessionKey,
          timestamp: event.timestamp,
        };
        
        if (options.includeMetadata) {
          body.metadata = event.metadata;
        }
        
        await fetch(options.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        console.error('External notifier failed:', error);
      }
    },
  };
}

/**
 * Create a hook that cleans up resources when sessions end.
 */
export function createCleanupHook(options: {
  cleanupFn: (sessionKey: string) => void | Promise<void>;
  eventTypes?: SessionEventType[];
}): LifecycleHook {
  return {
    id: 'cleanup_hook',
    name: 'Session Cleanup',
    eventTypes: options.eventTypes || ['session:ended', 'session:aborted', 'session:error'],
    priority: 100, // Run first for cleanup
    handler: async (event: SessionEvent) => {
      try {
        await options.cleanupFn(event.sessionKey);
      } catch (error) {
        console.error('Cleanup hook error:', error);
      }
    },
  };
}

// ============================================================================
// Session Event Emitters
// ============================================================================

/**
 * Emit session created event.
 */
export function emitSessionCreated(
  sessionKey: string,
  parentSessionKey?: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:created',
    sessionKey,
    timestamp: Date.now(),
    parentSessionKey,
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'pending' });
}

/**
 * Emit session started event.
 */
export function emitSessionStarted(
  sessionKey: string,
  depth?: number,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:started',
    sessionKey,
    timestamp: Date.now(),
    depth,
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'active' });
}

/**
 * Emit session yielded event (waiting for input).
 */
export function emitSessionYielded(
  sessionKey: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:yielded',
    sessionKey,
    timestamp: Date.now(),
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'yielded' });
}

/**
 * Emit session continued event (resumed after yield).
 */
export function emitSessionContinued(
  sessionKey: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:continued',
    sessionKey,
    timestamp: Date.now(),
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'active' });
}

/**
 * Emit session ended event.
 */
export function emitSessionEnded(
  sessionKey: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:ended',
    sessionKey,
    timestamp: Date.now(),
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'ended' });
}

/**
 * Emit session error event.
 */
export function emitSessionError(
  sessionKey: string,
  error: Error,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:error',
    sessionKey,
    timestamp: Date.now(),
    metadata: {
      ...metadata,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
    },
  });
}

/**
 * Emit session timeout event.
 */
export function emitSessionTimeout(
  sessionKey: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:timeout',
    sessionKey,
    timestamp: Date.now(),
    metadata,
  });
}

/**
 * Emit session aborted event.
 */
export function emitSessionAborted(
  sessionKey: string,
  metadata?: Record<string, unknown>
): void {
  sessionLifecycleHooks.emit({
    type: 'session:aborted',
    sessionKey,
    timestamp: Date.now(),
    metadata,
  });
  sessionLifecycleHooks.updateSessionState(sessionKey, { status: 'ended' });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get session duration in milliseconds.
 */
export function getSessionDuration(sessionKey: string): number | undefined {
  const state = sessionLifecycleHooks.getSessionState(sessionKey);
  if (!state) return undefined;
  
  if (state.startedAt) {
    const endTime = state.endedAt || Date.now();
    return endTime - state.startedAt;
  }
  
  return undefined;
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Get active session count.
 */
export function getActiveSessionCount(): number {
  return sessionLifecycleHooks.getAllSessionStates()
    .filter(s => s.status === 'active').length;
}

/**
 * Get session statistics.
 */
export function getSessionStats(): {
  total: number;
  active: number;
  ended: number;
  pending: number;
  yielded: number;
  averageDuration?: number;
} {
  const states = sessionLifecycleHooks.getAllSessionStates();
  
  const stats = {
    total: states.length,
    active: 0,
    ended: 0,
    pending: 0,
    yielded: 0,
    averageDuration: undefined as number | undefined,
  };
  
  let totalDuration = 0;
  let endedCount = 0;
  
  for (const state of states) {
    switch (state.status) {
      case 'active':
        stats.active++;
        break;
      case 'ended':
        stats.ended++;
        if (state.startedAt && state.endedAt) {
          totalDuration += state.endedAt - state.startedAt;
          endedCount++;
        }
        break;
      case 'pending':
        stats.pending++;
        break;
      case 'yielded':
        stats.yielded++;
        break;
    }
  }
  
  if (endedCount > 0) {
    stats.averageDuration = totalDuration / endedCount;
  }
  
  return stats;
}
