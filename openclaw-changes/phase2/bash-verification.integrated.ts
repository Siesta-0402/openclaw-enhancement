/**
 * OpenClaw Bash Verification System
 * 
 * Inspired by Claude Code's bashSecurity.ts (src/tools/BashTool/bashSecurity.ts)
 * and toolOrchestration.ts (src/services/tools/toolOrchestration.ts).
 * 
 * This module provides comprehensive bash command validation including:
 * - Command syntax checking
 * - Dangerous pattern detection
 * - Output length control
 * - Permission result types
 * 
 * Reference: Claude Code uses ~20+ security check IDs with numeric identifiers
 * to avoid logging strings, and uses behavior: 'allow' | 'ask' | 'passthrough'.
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export type BashVerificationBehavior = 'allow' | 'ask' | 'passthrough' | 'deny';

export interface PermissionResult {
  behavior: BashVerificationBehavior;
  message?: string;
  updatedInput?: { command: string };
  decisionReason?: {
    type: 'other' | 'safetyCheck';
    reason: string;
  };
  isSecurityCheck?: boolean;
}

export interface ValidationContext {
  originalCommand: string;
  baseCommand: string;
  unquotedContent: string;
  fullyUnquotedContent: string;
  fullyUnquotedPreStrip: string;
  unquotedKeepQuoteChars: string;
}

export interface BashVerificationResult {
  isSafe: boolean;
  behavior: BashVerificationBehavior;
  warnings: string[];
  sanitizedCommand?: string;
  checkDetails: CheckDetail[];
}

export interface CheckDetail {
  checkId: number;
  checkName: string;
  passed: boolean;
  message?: string;
}

// Numeric IDs for bash security checks (to avoid logging strings, like Claude Code)
export const BASH_SECURITY_CHECK_IDS = {
  EMPTY_COMMAND: 1,
  INCOMPLETE_COMMAND: 2,
  SHELL_METACHARACTERS: 3,
  DANGEROUS_VARIABLES: 4,
  COMMAND_SUBSTITUTION: 5,
  INPUT_REDIRECTION: 6,
  OUTPUT_REDIRECTION: 7,
  IFS_INJECTION: 8,
  PROC_ENVIRON_ACCESS: 9,
  MALFORMED_TOKEN: 10,
  BACKSLASH_ESCAPED_WHITESPACE: 11,
  BACKSLASH_ESCAPED_OPERATORS: 12,
  UNICODE_WHITESPACE: 13,
  MID_WORD_HASH: 14,
  BRACE_EXPANSION: 15,
  ZSH_DANGEROUS_COMMANDS: 16,
  CARRIAGE_RETURN: 17,
  COMMENT_QUOTE_DESYNC: 18,
  QUOTED_NEWLINE: 19,
  CONTROL_CHARACTERS: 20,
  DANGEROUS_FLAGS: 21,
  HEREDOC_SUBSTITUTION: 22,
  GIT_COMMIT_SUBSTITUTION: 23,
  JQ_SYSTEM_FUNCTION: 24,
  JQ_DANGEROUS_FLAGS: 25,
  PATH_TRAVERSAL: 26,
  PERMISSION_ESCALATION: 27,
} as const;

// ============================================================================
// Command Classification (from OpenClaw's existing command-classifier.ts)
// ============================================================================

export type BashCommandCategory =
  | 'search'
  | 'read'
  | 'list'
  | 'write'
  | 'destructive'
  | 'network'
  | 'interactive'
  | 'other';

export const BASH_COMMAND_CATEGORIES = {
  SEARCH: new Set([
    'find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis', 'fd',
  ]),
  READ: new Set([
    'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings',
    'jq', 'awk', 'cut', 'sort', 'uniq', 'tr', 'sed', 'diff', 'wget', 'curl',
  ]),
  LIST: new Set([
    'ls', 'tree', 'du', 'fd', 'find', 'pwd', 'cd', 'dir',
  ]),
  DESTRUCTIVE: new Set([
    'rm', 'rmdir', 'dd', 'shred', 'mkfs', 'fdisk', 'parted', 'truncate',
    'fallocate', 'wipe', 'secure-delete',
  ]),
  NETWORK: new Set([
    'wget', 'curl', 'httpie', 'nc', 'netcat', 'ssh', 'scp', 'sftp',
    'ftp', 'telnet', 'ping', 'traceroute',
  ]),
  INTERACTIVE: new Set([
    'vim', 'nano', 'emacs', 'man', 'htop', 'top', 'less', 'more', 'ssh',
    'telnet', 'ftp', 'telnet',
  ]),
  SILENT: new Set([
    'mv', 'cp', 'mkdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd',
    'export', 'unset', 'wait', 'alias', 'unalias', 'cd',
  ]),
  DANGEROUS_FLAGS: new Set([
    // find flags
    '-exec', '-ok', '-delete', '-execdir', '-okdir',
    // chmod flags
    '-R', '--recursive',
    // ssh flags that can specify commands
    '-o', '-i',
    // git flags that can execute code
    '-p', '--patch',
  ]),
} as const;

// ============================================================================
// Quote Extraction (from Claude Code's extractQuotedContent)
// ============================================================================

interface QuoteExtraction {
  withDoubleQuotes: string;
  fullyUnquoted: string;
  unquotedKeepQuoteChars: string;
}

function extractQuotedContent(command: string): QuoteExtraction {
  let withDoubleQuotes = '';
  let fullyUnquoted = '';
  let unquotedKeepQuoteChars = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      if (!inSingleQuote) withDoubleQuotes += char;
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      unquotedKeepQuoteChars += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      unquotedKeepQuoteChars += char;
      continue;
    }

    if (!inSingleQuote) withDoubleQuotes += char;
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char;
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char;
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars };
}

function stripSafeRedirections(content: string): string {
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '');
}

// ============================================================================
// Security Validators
// ============================================================================

function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    };
  }
  return { behavior: 'passthrough', message: 'Command is not empty' };
}

function validateIncompleteCommand(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;
  const trimmed = originalCommand.trim();

  if (/^\s*\t/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with tab)',
    };
  }

  if (trimmed.startsWith('-')) {
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with flags)',
    };
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command appears to be a continuation line (starts with operator)',
    };
  }

  return { behavior: 'passthrough', message: 'Command appears complete' };
}

function validateShellMetacharacters(context: ValidationContext): PermissionResult {
  const { unquotedContent } = context;

  // Check for shell metacharacters in unquoted content
  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    return {
      behavior: 'ask',
      message: 'Command contains shell metacharacters (;, |, or &) in arguments',
    };
  }

  // Check for dangerous find patterns
  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-regex\s+["'][^"']*[;|&][^"']*["']/,
  ];

  if (globPatterns.some(p => p.test(unquotedContent))) {
    return { behavior: 'ask', message: 'Command contains shell metacharacters in glob patterns' };
  }

  return { behavior: 'passthrough', message: 'No metacharacters' };
}

function validateDangerousVariables(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context;

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    return {
      behavior: 'ask',
      message: 'Command contains variables in dangerous contexts (redirections or pipes)',
    };
  }

  return { behavior: 'passthrough', message: 'No dangerous variables' };
}

function validateCommandSubstitution(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context;

  const patterns = [
    { pattern: /\$__/g, message: '$__ arbitrary execution' },
    { pattern: /\$\(.*\)/g, message: '$() command substitution' },
    { pattern: /`[^`]+`/g, message: 'backtick command substitution' },
    { pattern: /\$\{.*\}/g, message: '${} parameter substitution' },
    { pattern: /\$\[/g, message: '$[] legacy arithmetic expansion' },
    { pattern: /<\(/g, message: 'process substitution <()' },
    { pattern: />\(/g, message: 'process substitution >()' },
  ];

  for (const { pattern, message } of patterns) {
    if (pattern.test(fullyUnquotedContent)) {
      return { behavior: 'ask', message: `Command contains ${message}` };
    }
  }

  return { behavior: 'passthrough', message: 'No command substitution' };
}

function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context;

  if (/<(?!\/dev\/null)/.test(fullyUnquotedContent)) {
    return {
      behavior: 'ask',
      message: 'Command contains input redirection (<) which could read sensitive files',
    };
  }

  if (/>(?!\/dev\/null)/.test(fullyUnquotedContent)) {
    return {
      behavior: 'ask',
      message: 'Command contains output redirection (>) which could write to arbitrary files',
    };
  }

  return { behavior: 'passthrough', message: 'No dangerous redirections' };
}

function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command contains IFS variable usage which could bypass security validation',
    };
  }

  return { behavior: 'passthrough', message: 'No IFS injection detected' };
}

function validateProcEnvironAccess(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command accesses /proc/*/environ which could expose sensitive environment variables',
    };
  }

  return { behavior: 'passthrough', message: 'No /proc/environ access detected' };
}

function validateDangerousFlags(context: ValidationContext): PermissionResult {
  const { baseCommand, originalCommand } = context;

  // Check for dangerous flags based on command
  if (baseCommand === 'find') {
    if (/\s(-exec|-ok|-delete|-execdir|-okdir)\s/.test(originalCommand)) {
      return {
        behavior: 'ask',
        message: 'find with -exec/-delete can execute arbitrary commands or delete files',
      };
    }
  }

  if (baseCommand === 'chmod') {
    if (/\s[0-7]{3,4}\s/.test(originalCommand)) {
      return {
        behavior: 'ask',
        message: 'chmod with octal permissions may be used for permission escalation',
      };
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous flags detected' };
}

function validatePathTraversal(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  // Check for path traversal patterns
  if (/\.\.\/|\.\.\\/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command contains path traversal sequences (../)',
    };
  }

  return { behavior: 'passthrough', message: 'No path traversal detected' };
}

function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: 'No carriage return' };
  }

  // Check for CR outside double quotes
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (c === '\r' && !inDoubleQuote) {
      return {
        behavior: 'ask',
        message: 'Command contains carriage return (\\r) which can cause parsing inconsistencies',
      };
    }
  }

  return { behavior: 'passthrough', message: 'CR only inside double quotes' };
}

function validateControlCharacters(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command contains non-printable control characters',
    };
  }

  return { behavior: 'passthrough', message: 'No control characters' };
}

function validateUnicodeWhitespace(context: ValidationContext): PermissionResult {
  const { originalCommand } = context;

  // eslint-disable-next-line no-misleading-character-class
  if (/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/.test(originalCommand)) {
    return {
      behavior: 'ask',
      message: 'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
    };
  }

  return { behavior: 'passthrough', message: 'No Unicode whitespace' };
}

function validateZshDangerousCommands(context: ValidationContext): PermissionResult {
  const { baseCommand } = context;

  const ZSH_DANGEROUS = new Set([
    'zmodload', 'emulate', 'sysopen', 'sysread', 'syswrite', 'sysseek',
    'zpty', 'ztcp', 'zsocket', 'zf_rm', 'zf_mv', 'zf_ln', 'zf_chmod',
  ]);

  if (ZSH_DANGEROUS.has(baseCommand)) {
    return {
      behavior: 'ask',
      message: `Command uses Zsh-specific '${baseCommand}' which can bypass security checks`,
    };
  }

  return { behavior: 'passthrough', message: 'No Zsh dangerous commands' };
}

// ============================================================================
// Main Verification Function
// ============================================================================

const VALIDATORS = [
  { fn: validateEmpty, checkId: BASH_SECURITY_CHECK_IDS.EMPTY_COMMAND, name: 'empty' },
  { fn: validateIncompleteCommand, checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMAND, name: 'incomplete' },
  { fn: validateShellMetacharacters, checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS, name: 'metacharacters' },
  { fn: validateDangerousVariables, checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES, name: 'dangerous_variables' },
  { fn: validateCommandSubstitution, checkId: BASH_SECURITY_CHECK_IDS.COMMAND_SUBSTITUTION, name: 'command_substitution' },
  { fn: validateRedirections, checkId: BASH_SECURITY_CHECK_IDS.OUTPUT_REDIRECTION, name: 'redirections' },
  { fn: validateIFSInjection, checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION, name: 'ifs_injection' },
  { fn: validateProcEnvironAccess, checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS, name: 'proc_environ' },
  { fn: validateDangerousFlags, checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_FLAGS, name: 'dangerous_flags' },
  { fn: validatePathTraversal, checkId: BASH_SECURITY_CHECK_IDS.PATH_TRAVERSAL, name: 'path_traversal' },
  { fn: validateCarriageReturn, checkId: BASH_SECURITY_CHECK_IDS.CARRIAGE_RETURN, name: 'carriage_return' },
  { fn: validateControlCharacters, checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS, name: 'control_characters' },
  { fn: validateUnicodeWhitespace, checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE, name: 'unicode_whitespace' },
  { fn: validateZshDangerousCommands, checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS, name: 'zsh_dangerous' },
];

/**
 * Main bash command verification function.
 * Runs all security validators and returns a comprehensive result.
 */
export function verifyBashCommand(command: string): BashVerificationResult {
  const warnings: string[] = [];
  const checkDetails: CheckDetail[] = [];
  let behavior: BashVerificationBehavior = 'allow';

  if (!command || !command.trim()) {
    return {
      isSafe: true,
      behavior: 'allow',
      warnings: [],
      checkDetails: [{
        checkId: BASH_SECURITY_CHECK_IDS.EMPTY_COMMAND,
        checkName: 'empty',
        passed: true,
        message: 'Empty command is safe',
      }],
    };
  }

  const baseCommand = command.trim().split(/\s+/)[0] || '';
  const quoteExtraction = extractQuotedContent(command);
  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: quoteExtraction.withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(quoteExtraction.fullyUnquoted),
    fullyUnquotedPreStrip: quoteExtraction.fullyUnquoted,
    unquotedKeepQuoteChars: quoteExtraction.unquotedKeepQuoteChars,
  };

  for (const { fn, checkId, name } of VALIDATORS) {
    const result = fn(context);
    
    checkDetails.push({
      checkId,
      checkName: name,
      passed: result.behavior === 'passthrough' || result.behavior === 'allow',
      message: result.message,
    });

    if (result.behavior === 'ask') {
      warnings.push(result.message || `Security check '${name}' triggered`);
      behavior = 'ask';
    } else if (result.behavior === 'deny') {
      behavior = 'deny';
      break;
    }
  }

  return {
    isSafe: behavior === 'allow',
    behavior,
    warnings,
    checkDetails,
  };
}

/**
 * Quick check if a command is safe without detailed analysis.
 */
export function isCommandSafe(command: string): boolean {
  const result = verifyBashCommand(command);
  return result.isSafe;
}

/**
 * Get command category for display purposes.
 */
export function getCommandCategory(command: string): BashCommandCategory {
  const baseCommand = command.trim().split(/\s+/)[0] || '';

  if (BASH_COMMAND_CATEGORIES.SEARCH.has(baseCommand)) return 'search';
  if (BASH_COMMAND_CATEGORIES.READ.has(baseCommand)) return 'read';
  if (BASH_COMMAND_CATEGORIES.LIST.has(baseCommand)) return 'list';
  if (BASH_COMMAND_CATEGORIES.DESTRUCTIVE.has(baseCommand)) return 'destructive';
  if (BASH_COMMAND_CATEGORIES.NETWORK.has(baseCommand)) return 'network';
  if (BASH_COMMAND_CATEGORIES.INTERACTIVE.has(baseCommand)) return 'interactive';

  return 'other';
}

// ============================================================================
// Output Length Control
// ============================================================================

export interface OutputControlOptions {
  maxLines?: number;
  maxBytes?: number;
  maxIdleMs?: number;
  truncateSuffix?: string;
}

const DEFAULT_OUTPUT_OPTIONS: OutputControlOptions = {
  maxLines: 10000,
  maxBytes: 10 * 1024 * 1024, // 10MB
  maxIdleMs: 300000, // 5 minutes
  truncateSuffix: '\n[... output truncated ...]',
};

/**
 * Control output size by limiting lines, bytes, and duration.
 * Inspired by Claude Code's output length management in toolOrchestration.ts.
 */
export class OutputController {
  private lines: string[] = [];
  private totalBytes = 0;
  private lastUpdateTime = Date.now();
  private readonly options: OutputControlOptions;
  private truncated = false;

  constructor(options: OutputControlOptions = {}) {
    this.options = { ...DEFAULT_OUTPUT_OPTIONS, ...options };
  }

  /**
   * Add a line of output, respecting limits.
   */
  addLine(line: string): boolean {
    if (this.truncated) return false;

    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline

    // Check byte limit
    if (this.totalBytes + lineBytes > this.options.maxBytes) {
      this.truncate();
      return false;
    }

    // Check line limit
    if (this.lines.length >= this.options.maxLines) {
      this.truncate();
      return false;
    }

    this.lines.push(line);
    this.totalBytes += lineBytes;
    this.lastUpdateTime = Date.now();
    return true;
  }

  /**
   * Add multiple lines at once.
   */
  addLines(lines: string[]): number {
    let added = 0;
    for (const line of lines) {
      if (this.addLine(line)) {
        added++;
      } else {
        break;
      }
    }
    return added;
  }

  /**
   * Check if output has been idle for too long.
   */
  isIdle(): boolean {
    return Date.now() - this.lastUpdateTime > this.options.maxIdleMs;
  }

  /**
   * Get idle time in milliseconds.
   */
  getIdleTimeMs(): number {
    return Date.now() - this.lastUpdateTime;
  }

  /**
   * Check if output was truncated.
   */
  isTruncated(): boolean {
    return this.truncated;
  }

  /**
   * Get current line count.
   */
  getLineCount(): number {
    return this.lines.length;
  }

  /**
   * Get current byte count.
   */
  getByteCount(): number {
    return this.totalBytes;
  }

  /**
   * Get all accumulated output.
   */
  getOutput(): string {
    return this.lines.join('\n');
  }

  /**
   * Get output with truncation marker if needed.
   */
  getOutputWithMarker(): string {
    if (this.truncated) {
      return this.lines.join('\n') + this.options.truncateSuffix;
    }
    return this.lines.join('\n');
  }

  /**
   * Truncate output and add suffix.
   */
  private truncate(): void {
    if (!this.truncated) {
      this.truncated = true;
      // Remove last few lines to make room for suffix
      const suffixLines = this.options.truncateSuffix.split('\n').length;
      while (this.lines.length > 0 && this.lines.length + suffixLines > this.options.maxLines) {
        this.lines.shift();
      }
    }
  }

  /**
   * Create a snapshot of current state.
   */
  snapshot(): OutputSnapshot {
    return {
      lines: this.lines.slice(),
      totalBytes: this.totalBytes,
      truncated: this.truncated,
      lastUpdateTime: this.lastUpdateTime,
      lineCount: this.lines.length,
    };
  }
}

export interface OutputSnapshot {
  lines: string[];
  totalBytes: number;
  truncated: boolean;
  lastUpdateTime: number;
  lineCount: number;
}

/**
 * Factory function to create an output controller with defaults.
 */
export function createOutputController(options?: OutputControlOptions): OutputController {
  return new OutputController(options);
}

// ============================================================================
// Permission Request Formatting
// ============================================================================

/**
 * Format a permission request message for display.
 * Inspired by Claude Code's createPermissionRequestMessage pattern.
 */
export function formatPermissionRequest(
  command: string,
  result: BashVerificationResult,
): string {
  const lines = [
    '⚠️  Bash Command Verification',
    '',
    '```bash',
    command,
    '```',
    '',
  ];

  if (result.warnings.length > 0) {
    lines.push('**Security Checks Triggered:**');
    for (const warning of result.warnings) {
      lines.push(`- ⚠️ ${warning}`);
    }
    lines.push('');
  }

  lines.push(`**Category:** \`${getCommandCategory(command)}\``);
  lines.push(`**Verdict:** ${result.isSafe ? '✅ Safe' : '⚠️ Requires Review'}`);
  
  return lines.join('\n');
}
