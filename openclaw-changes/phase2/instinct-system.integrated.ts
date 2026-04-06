/**
 * OpenClaw Instinct System
 * 
 * The Instinct System implements automatic, pre-conscious responses that
 * the AI agent should exhibit without explicit prompting. These are
 * "second nature" behaviors that emerge from training or learned patterns.
 * 
 * Types of Instincts:
 * 1. Safety Instincts - Immediate threat response
 * 2. Memory Instincts - Automatic memory triggers
 * 3. Pattern Instincts - Pattern recognition triggers
 * 4. Proactive Instincts - Pre-planned actions
 * 5. Self-Preservation Instincts - Protecting agent continuity
 * 
 * Unlike explicit behaviors that require user prompts, instincts fire
 * automatically based on context signals.
 */

import { BashVerificationBehavior, PermissionResult, ValidationContext } from '../../agents/bash-verification.js';

// ============================================================================
// Instinct Types
// ============================================================================

export type InstinctCategory =
  | 'safety'
  | 'memory'
  | 'pattern'
  | 'proactive'
  | 'self_preservation'
  | 'communication';

export type InstinctStrength = 'critical' | 'strong' | 'moderate' | 'weak';

export interface InstinctSignal {
  type: string;
  intensity: number; // 0-1
  source: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Instinct {
  id: string;
  name: string;
  category: InstinctCategory;
  description: string;
  strength: InstinctStrength;
  enabled: boolean;
  signals: string[]; // Signal types this instinct responds to
  trigger: (context: InstinctContext) => TriggerResult | Promise<TriggerResult>;
  cooldown?: number; // Minimum ms between triggers
  lastTriggered?: number;
}

export interface InstinctContext {
  sessionKey: string;
  signals: InstinctSignal[];
  recentErrors: Error[];
  userMessage?: string;
  toolCalls?: string[];
  fileChanges?: string[];
  memoryIndicators?: string[];
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  sessionDuration?: number;
}

export interface TriggerResult {
  action?: InstinctAction;
  reason: string;
  priority: number;
  suppressOutput?: boolean;
}

export interface InstinctAction {
  type: string;
  payload?: unknown;
  immediate?: boolean;
}

// ============================================================================
// Instinct Registry
// ============================================================================

class InstinctSystem {
  private instincts: Map<string, Instinct> = new Map();
  private activeSignals: InstinctSignal[] = [];
  private lastEvaluation = 0;
  private evaluationInterval = 1000; // ms

  constructor() {
    this.registerBuiltInInstincts();
  }

  /**
   * Register an instinct.
   */
  register(instinct: Instinct): () => void {
    if (!instinct.id) {
      instinct.id = `instinct_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }
    
    this.instincts.set(instinct.id, instinct);
    
    // Return unregister function
    return () => this.unregister(instinct.id);
  }

  /**
   * Unregister an instinct.
   */
  unregister(instinctId: string): boolean {
    return this.instincts.delete(instinctId);
  }

  /**
   * Get all registered instincts.
   */
  getInstincts(): Instinct[] {
    return Array.from(this.instincts.values());
  }

  /**
   * Get instincts by category.
   */
  getInstinctsByCategory(category: InstinctCategory): Instinct[] {
    return Array.from(this.instincts.values())
      .filter(i => i.category === category);
  }

  /**
   * Enable/disable an instinct.
   */
  setEnabled(instinctId: string, enabled: boolean): boolean {
    const instinct = this.instincts.get(instinctId);
    if (instinct) {
      instinct.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Emit a signal that instincts can respond to.
   */
  emitSignal(signal: InstinctSignal): void {
    signal.timestamp = Date.now();
    this.activeSignals.push(signal);
    
    // Keep only recent signals (last 100)
    if (this.activeSignals.length > 100) {
      this.activeSignals = this.activeSignals.slice(-100);
    }
  }

  /**
   * Get recent signals.
   */
  getRecentSignals(types?: string[]): InstinctSignal[] {
    if (!types) return [...this.activeSignals];
    
    const cutoff = Date.now() - 60000; // Last minute
    return this.activeSignals.filter(s => 
      types.includes(s.type) && s.timestamp > cutoff
    );
  }

  /**
   * Evaluate all instincts based on current context.
   */
  async evaluate(context: InstinctContext): Promise<EvaluationResult> {
    const results: TriggerResult[] = [];
    const triggered: { instinct: Instinct; result: TriggerResult }[] = [];
    
    for (const instinct of this.instincts.values()) {
      if (!instinct.enabled) continue;
      
      // Check cooldown
      if (instinct.cooldown && instinct.lastTriggered) {
        if (Date.now() - instinct.lastTriggered < instinct.cooldown) {
          continue;
        }
      }
      
      // Check if any of the instinct's signal types are in recent signals
      const relevantSignals = context.signals.filter(s => 
        instinct.signals.includes(s.type)
      );
      
      if (relevantSignals.length === 0 && instinct.signals.length > 0) {
        continue; // No relevant signals for this instinct
      }
      
      // Add signals to context
      const contextWithSignals = {
        ...context,
        signals: relevantSignals.length > 0 ? relevantSignals : context.signals,
      };
      
      try {
        const result = await instinct.trigger(contextWithSignals);
        
        if (result.action) {
          instinct.lastTriggered = Date.now();
          triggered.push({ instinct, result });
          results.push(result);
        }
      } catch (error) {
        console.error(`Instinct ${instinct.id} error:`, error);
      }
    }
    
    // Sort by priority
    triggered.sort((a, b) => b.result.priority - a.result.priority);
    
    this.lastEvaluation = Date.now();
    
    return {
      timestamp: Date.now(),
      evaluatedCount: this.instincts.size,
      triggeredCount: triggered.length,
      triggered,
      allResults: results,
    };
  }

  /**
   * Register built-in instincts.
   */
  private registerBuiltInInstincts(): void {
    // Safety: Detect dangerous commands
    this.register({
      id: 'safety_dangerous_command',
      name: 'Dangerous Command Warning',
      category: 'safety',
      description: 'Automatically flag dangerous commands before execution',
      strength: 'critical',
      enabled: true,
      signals: ['command_submission', 'exec_request'],
      cooldown: 0,
      trigger: (context) => {
        const execSignal = context.signals.find(s => s.type === 'exec_request');
        if (!execSignal) return { reason: 'No exec signal', priority: 0 };
        
        const command = execSignal.metadata?.command as string;
        if (!command) return { reason: 'No command in signal', priority: 0 };
        
        // Check for dangerous patterns
        const dangerousPatterns = [
          { pattern: /rm\s+-rf\s+\//, message: 'Recursive root deletion' },
          { pattern: /:\(\)\{\s*:\|:\s*&\s*\};:  # Fork bomb/, message: 'Fork bomb detected' },
          { pattern: /dd\s+if=.*of=\/dev\/sd/, message: 'Direct disk write' },
          { pattern: /chmod\s+-R\s+777/, message: 'World-writable permissions' },
          { pattern: /curl.*\|.*sh/, message: 'Pipe to shell (curl)' },
          { pattern: /wget.*\|.*sh/, message: 'Pipe to shell (wget)' },
        ];
        
        for (const { pattern, message } of dangerousPatterns) {
          if (pattern.test(command)) {
            return {
              action: {
                type: 'safety_warning',
                payload: { message, command },
                immediate: true,
              },
              reason: message,
              priority: 100,
            };
          }
        }
        
        return { reason: 'No danger detected', priority: 0 };
      },
    });

    // Safety: Detect potential data loss
    this.register({
      id: 'safety_data_loss',
      name: 'Data Loss Warning',
      category: 'safety',
      description: 'Warn before operations that may cause data loss',
      strength: 'strong',
      enabled: true,
      signals: ['command_submission'],
      cooldown: 0,
      trigger: (context) => {
        const execSignal = context.signals.find(s => s.type === 'command_submission');
        if (!execSignal) return { reason: 'No command signal', priority: 0 };
        
        const command = execSignal.metadata?.command as string;
        if (!command) return { reason: 'No command', priority: 0 };
        
        const dataLossPatterns = [
          { pattern: /\brm\s+[^\*]*$/m, message: 'Unqualified rm command' },
          { pattern: /\bmv\s+[^\s]+\s+[^\s]+\s+&&?\s*rm/, message: 'Move then delete pattern' },
          { pattern: /\btruncate\b/, message: 'File truncation' },
          { pattern: /\bfallocate\s+-d\b/, message: 'File deallocation' },
        ];
        
        for (const { pattern, message } of dataLossPatterns) {
          if (pattern.test(command)) {
            return {
              action: {
                type: 'data_loss_warning',
                payload: { message, command },
              },
              reason: message,
              priority: 80,
            };
          }
        }
        
        return { reason: 'No data loss risk detected', priority: 0 };
      },
    });

    // Memory: Remember important facts
    this.register({
      id: 'memory_learn_from_error',
      name: 'Learn from Errors',
      category: 'memory',
      description: 'Automatically create memory entries from repeated errors',
      strength: 'moderate',
      enabled: true,
      signals: ['error'],
      cooldown: 5000,
      trigger: (context) => {
        if (context.recentErrors.length === 0) {
          return { reason: 'No recent errors', priority: 0 };
        }
        
        // Check for repeated errors
        const errorMessages = context.recentErrors.map(e => e.message);
        const unique = new Set(errorMessages);
        
        if (unique.size < 3) {
          // Repeated or similar errors
          return {
            action: {
              type: 'create_memory_entry',
              payload: {
                type: 'error_pattern',
                errors: errorMessages,
                count: errorMessages.length,
              },
            },
            reason: `Repeated error pattern detected (${errorMessages.length} occurrences)`,
            priority: 50,
          };
        }
        
        return { reason: 'Unique errors, no pattern', priority: 0 };
      },
    });

    // Pattern: Recognize work patterns
    this.register({
      id: 'pattern_work_session',
      name: 'Work Session Recognition',
      category: 'pattern',
      description: 'Detect sustained work sessions and adjust behavior',
      strength: 'weak',
      enabled: true,
      signals: ['tool_call', 'user_message'],
      cooldown: 30000,
      trigger: (context) => {
        const hasMultipleToolCalls = context.toolCalls && context.toolCalls.length > 5;
        const hasSustainedActivity = context.sessionDuration && context.sessionDuration > 300000; // 5 min
        
        if (hasMultipleToolCalls && hasSustainedActivity) {
          return {
            action: {
              type: 'adjust_behavior',
              payload: { mode: 'focus', reason: 'Sustained work detected' },
            },
            reason: 'Sustained work session detected',
            priority: 30,
          };
        }
        
        return { reason: 'No sustained activity', priority: 0 };
      },
    });

    // Proactive: Offer help when stuck
    this.register({
      id: 'proactive_stuck_detection',
      name: 'Stuck Detection',
      category: 'proactive',
      description: 'Detect when user might be stuck and offer help',
      strength: 'weak',
      enabled: true,
      signals: ['repeated_command', 'error'],
      cooldown: 60000,
      trigger: (context) => {
        const repeatedSignal = context.signals.find(s => 
          s.type === 'repeated_command' && s.intensity > 0.5
        );
        
        if (repeatedSignal) {
          return {
            action: {
              type: 'proactive_suggestion',
              payload: {
                type: 'alternative_approach',
                context: repeatedSignal.metadata,
              },
            },
            reason: 'Repeated command detected',
            priority: 40,
          };
        }
        
        return { reason: 'No stuck pattern', priority: 0 };
      },
    });

    // Self-preservation: Session cleanup
    this.register({
      id: 'self_pres_cleanup',
      name: 'Session Cleanup',
      category: 'self_preservation',
      description: 'Clean up temporary resources before session end',
      strength: 'strong',
      enabled: true,
      signals: ['session_ending'],
      cooldown: 0,
      trigger: (context) => {
        return {
          action: {
            type: 'cleanup_resources',
            payload: {
              tempFiles: true,
              caches: true,
              logs: false, // Keep logs
            },
          },
          reason: 'Session ending, cleaning up resources',
          priority: 90,
        };
      },
    });

    // Self-preservation: Commit valuable work
    this.register({
      id: 'self_pres_auto_commit',
      name: 'Auto-commit Valuable Work',
      category: 'self_preservation',
      description: 'Commit significant changes automatically',
      strength: 'moderate',
      enabled: true,
      signals: ['file_change'],
      cooldown: 300000, // 5 min between auto-commits
      trigger: (context) => {
        const changeSignal = context.signals.find(s => s.type === 'file_change');
        if (!changeSignal) return { reason: 'No file change', priority: 0 };
        
        const files = changeSignal.metadata?.files as string[];
        if (!files || files.length === 0) return { reason: 'No files in signal', priority: 0 };
        
        // Check for significant changes
        const significantExtensions = ['.ts', '.js', '.md', '.json', '.py'];
        const significantFiles = files.filter(f => 
          significantExtensions.some(ext => f.endsWith(ext))
        );
        
        if (significantFiles.length >= 3) {
          return {
            action: {
              type: 'suggest_git_commit',
              payload: {
                files: significantFiles,
                reason: 'Significant changes detected',
              },
            },
            reason: `Significant changes in ${significantFiles.length} files`,
            priority: 60,
          };
        }
        
        return { reason: 'Changes not significant enough', priority: 0 };
      },
    });

    // Communication: Time-aware greeting
    this.register({
      id: 'communication_greeting',
      name: 'Contextual Greeting',
      category: 'communication',
      description: 'Greet based on time of day and session context',
      strength: 'weak',
      enabled: true,
      signals: ['session_start'],
      cooldown: 0,
      trigger: (context) => {
        const hour = new Date().getHours();
        let timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
        
        if (hour >= 5 && hour < 12) {
          timeOfDay = 'morning';
        } else if (hour >= 12 && hour < 17) {
          timeOfDay = 'afternoon';
        } else if (hour >= 17 && hour < 21) {
          timeOfDay = 'evening';
        } else {
          timeOfDay = 'night';
        }
        
        return {
          action: {
            type: 'contextual_greeting',
            payload: { timeOfDay },
            suppressOutput: false,
          },
          reason: `Time-appropriate greeting for ${timeOfDay}`,
          priority: 10,
        };
      },
    });

    // Safety: Binary file warning
    this.register({
      id: 'safety_binary_warning',
      name: 'Binary File Warning',
      category: 'safety',
      description: 'Warn before processing binary files with text tools',
      strength: 'strong',
      enabled: true,
      signals: ['file_read'],
      cooldown: 0,
      trigger: (context) => {
        const readSignal = context.signals.find(s => s.type === 'file_read');
        if (!readSignal) return { reason: 'No file read signal', priority: 0 };
        
        const filename = readSignal.metadata?.filename as string;
        const isBinary = readSignal.metadata?.isBinary as boolean;
        
        if (isBinary && filename) {
          return {
            action: {
              type: 'binary_warning',
              payload: { filename },
              immediate: true,
            },
            reason: 'Binary file detected',
            priority: 85,
          };
        }
        
        return { reason: 'Not a binary file', priority: 0 };
      },
    });
  }
}

// ============================================================================
// Types for Evaluation Results
// ============================================================================

export interface EvaluationResult {
  timestamp: number;
  evaluatedCount: number;
  triggeredCount: number;
  triggered: { instinct: Instinct; result: TriggerResult }[];
  allResults: TriggerResult[];
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const instinctSystem = new InstinctSystem();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Emit a command execution signal.
 */
export function emitCommandSignal(command: string, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'command_submission',
    intensity: 1,
    source: 'exec',
    timestamp: Date.now(),
    metadata: { command, ...metadata },
  });
}

/**
 * Emit an error signal.
 */
export function emitErrorSignal(error: Error, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'error',
    intensity: 1,
    source: 'error_handler',
    timestamp: Date.now(),
    metadata: {
      message: error.message,
      name: error.name,
      ...metadata,
    },
  });
}

/**
 * Emit a file change signal.
 */
export function emitFileChangeSignal(files: string[], metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'file_change',
    intensity: files.length,
    source: 'file_system',
    timestamp: Date.now(),
    metadata: { files, ...metadata },
  });
}

/**
 * Emit a session start signal.
 */
export function emitSessionStartSignal(sessionKey: string, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'session_start',
    intensity: 1,
    source: 'session_manager',
    timestamp: Date.now(),
    metadata: { sessionKey, ...metadata },
  });
}

/**
 * Emit a session ending signal.
 */
export function emitSessionEndSignal(sessionKey: string, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'session_ending',
    intensity: 1,
    source: 'session_manager',
    timestamp: Date.now(),
    metadata: { sessionKey, ...metadata },
  });
}

/**
 * Emit a tool call signal.
 */
export function emitToolCallSignal(toolName: string, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'tool_call',
    intensity: 1,
    source: 'tool_executor',
    timestamp: Date.now(),
    metadata: { toolName, ...metadata },
  });
}

/**
 * Emit a file read signal.
 */
export function emitFileReadSignal(filename: string, isBinary: boolean, metadata?: Record<string, unknown>): void {
  instinctSystem.emitSignal({
    type: 'file_read',
    intensity: 1,
    source: 'file_system',
    timestamp: Date.now(),
    metadata: { filename, isBinary, ...metadata },
  });
}

/**
 * Check instincts synchronously for immediate actions.
 */
export function checkImmediateInstincts(context: InstinctContext): TriggerResult[] {
  const results: TriggerResult[] = [];
  
  for (const instinct of instinctSystem.getInstincts()) {
    if (!instinct.enabled) continue;
    if (instinct.strength !== 'critical') continue;
    
    try {
      const result = instinct.trigger(context);
      // Skip async triggers for immediate checks
      if (result instanceof Promise) continue;
      if (result.action && result.priority >= 80) {
        results.push(result);
      }
    } catch {
      // Ignore errors for immediate checks
    }
  }
  
  return results.sort((a, b) => b.priority - a.priority);
}

/**
 * Get instinct system statistics.
 */
export function getInstinctStats(): {
  total: number;
  byCategory: Record<InstinctCategory, number>;
  byStrength: Record<InstinctStrength, number>;
  enabled: number;
  disabled: number;
} {
  const instincts = instinctSystem.getInstincts();
  
  const stats = {
    total: instincts.length,
    byCategory: {
      safety: 0,
      memory: 0,
      pattern: 0,
      proactive: 0,
      self_preservation: 0,
      communication: 0,
    } as Record<InstinctCategory, number>,
    byStrength: {
      critical: 0,
      strong: 0,
      moderate: 0,
      weak: 0,
    } as Record<InstinctStrength, number>,
    enabled: 0,
    disabled: 0,
  };
  
  for (const instinct of instincts) {
    stats.byCategory[instinct.category]++;
    stats.byStrength[instinct.strength]++;
    if (instinct.enabled) {
      stats.enabled++;
    } else {
      stats.disabled++;
    }
  }
  
  return stats;
}
