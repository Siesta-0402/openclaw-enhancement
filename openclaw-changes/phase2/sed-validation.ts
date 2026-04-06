/**
 * OpenClaw Sed Command Validation
 * 
 * Sed is a powerful stream editor that can modify files in dangerous ways.
 * This module provides specialized validation for sed commands including:
 * - Syntax validation
 * - Dangerous flag detection (-i, -z, etc.)
 * - Regex injection prevention
 * - In-place editing safety
 * - Path traversal protection
 */

import {
  BashVerificationBehavior,
  PermissionResult,
  ValidationContext,
  BashVerificationResult,
  CheckDetail,
  BASH_SECURITY_CHECK_IDS,
} from './bash-verification';

// ============================================================================
// Sed-Specific Types
// ============================================================================

export interface SedCommand {
  command: string;
  baseCommand: 'sed';
  flags: string[];
  script: string;
  targetFiles: string[];
  isInplaceEdit: boolean;
  hasRegex: boolean;
  hasAddress: boolean;
}

export interface SedValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
  sanitizedCommand?: string;
}

// Numeric IDs for sed security checks (extending BASH_SECURITY_CHECK_IDS)
export const SED_SECURITY_CHECK_IDS = {
  SED_EMPTY_SCRIPT: 100,
  SED_INVALID_FLAGS: 101,
  SED_DANGEROUS_FLAGS: 102,
  SED_REGEX_INJECTION: 103,
  SED_ADDRESS_INJECTION: 104,
  SED_MISSING_BACKUP_EXT: 105,
  SED_BINARY_CONTENT: 106,
  SED_NULL_CHARACTERS: 107,
  SED_RECURSIVE_PATH: 108,
  SED_WILDCARD_MIX: 109,
} as const;

// ============================================================================
// Dangerous Sed Flags
// ============================================================================

const DANGEROUS_SED_FLAGS = new Set([
  '-i',       // In-place editing without backup
  '--in-place',
  '-z',       // Null-terminated lines can bypass safety checks
  '--zero-terminated',
  '-u',       // Unbuffered output
  '--unbuffered',
  '-s',       // Make sed treat files as separate streams
  '--separate',
  '-E',       // Extended regex (can be harder to validate)
  '--extended-regexp',
  '-r',       // Extended regex (POSIX)
]);

const DANGEROUS_SED_ADDRESS_PATTERNS = [
  /\$\?/,     // Last line of previous sed command (chaining danger)
  /\$\d/,     // Specific line number from variable
  /~\d/,      // Step functions can create large ranges
];

// ============================================================================
// Sed Parsing
// ============================================================================

/**
 * Parse a sed command into its components.
 */
export function parseSedCommand(command: string): SedCommand | null {
  const trimmed = command.trim();
  
  // Check if this is a sed command
  if (!trimmed.startsWith('sed ')) {
    return null;
  }

  const result: SedCommand = {
    command: trimmed,
    baseCommand: 'sed',
    flags: [],
    script: '',
    targetFiles: [],
    isInplaceEdit: false,
    hasRegex: false,
    hasAddress: false,
  };

  // Tokenize while respecting quotes
  const tokens = tokenizeSedCommand(trimmed.slice(4)); // Remove 'sed '
  
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    result.flags.push(tokens[i]);
    if (tokens[i] === '-i' || tokens[i] === '--in-place') {
      result.isInplaceEdit = true;
    }
    i++;
  }

  // Next token should be the script
  if (i < tokens.length) {
    result.script = tokens[i];
    result.hasRegex = /[\/\^\$\.\*\+\?\[\\\(]/.test(result.script);
    i++;
  }

  // Remaining tokens are files
  while (i < tokens.length) {
    const token = tokens[i];
    // Skip options that look like flags
    if (!token.startsWith('-')) {
      result.targetFiles.push(token);
    }
    i++;
  }

  return result;
}

/**
 * Tokenize sed command arguments while respecting quotes.
 */
function tokenizeSedCommand(args: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < args.length; i++) {
    const char = args[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      current += char;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate empty sed script.
 */
function validateEmptyScript(sed: SedCommand): PermissionResult {
  if (!sed.script) {
    return {
      behavior: 'deny',
      message: 'sed requires a script to operate on',
      decisionReason: { type: 'safetyCheck', reason: 'Empty sed script' },
    };
  }
  return { behavior: 'passthrough', message: 'Sed script is not empty' };
}

/**
 * Validate sed flags for dangerous options.
 */
function validateSedFlags(sed: SedCommand): PermissionResult {
  for (const flag of sed.flags) {
    if (DANGEROUS_SED_FLAGS.has(flag)) {
      // Special handling for -i (in-place editing)
      if (flag === '-i' || flag === '--in-place') {
        // Check if backup extension is provided with -i
        if (flag === '-i' && sed.flags.indexOf('-i') !== sed.flags.length - 1) {
          const nextFlag = sed.flags[sed.flags.indexOf('-i') + 1];
          if (nextFlag && !nextFlag.startsWith('-')) {
            // Has backup extension - safer
            return { behavior: 'passthrough', message: 'sed -i with backup extension' };
          }
        }
        return {
          behavior: 'ask',
          message: `sed ${flag} performs in-place file editing which could corrupt files. Use 'sed ... > temp && mv temp file' instead for safer editing.`,
          decisionReason: { type: 'safetyCheck', reason: `Dangerous sed flag: ${flag}` },
        };
      }

      // -z can create dangerous null-byte patterns
      if (flag === '-z' || flag === '--zero-terminated') {
        return {
          behavior: 'ask',
          message: 'sed -z treats files as null-terminated lines which can bypass safety checks',
          decisionReason: { type: 'safetyCheck', reason: 'Dangerous sed flag: -z' },
        };
      }

      // -E enables extended regex which can be more complex
      if (flag === '-E' || flag === '--extended-regexp') {
        return {
          behavior: 'ask',
          message: 'sed -E uses extended regular expressions which can create complex patterns',
          decisionReason: { type: 'safetyCheck', reason: 'Extended regex enabled' },
        };
      }

      return {
        behavior: 'ask',
        message: `sed ${flag} is a potentially dangerous flag`,
        decisionReason: { type: 'safetyCheck', reason: `Dangerous sed flag: ${flag}` },
      };
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous sed flags' };
}

/**
 * Check for regex injection patterns in sed scripts.
 */
function validateRegexInjection(sed: SedCommand): PermissionResult {
  if (!sed.hasRegex) {
    return { behavior: 'passthrough', message: 'No regex patterns detected' };
  }

  const script = sed.script;

  // Check for command substitution in regex
  if (/\$[({]/.test(script)) {
    return {
      behavior: 'deny',
      message: 'sed script contains command substitution which could execute arbitrary code',
      decisionReason: { type: 'safetyCheck', reason: 'Command substitution in sed regex' },
    };
  }

  // Check for dangerous regex patterns
  const dangerousPatterns = [
    { pattern: /\\\(.*\\|/g, message: 'Nested alternation in regex' },
    { pattern: /\{\d+,\d+\}/g, message: 'Unbounded repetition quantifier' },
    { pattern: /\(\*\+\?\}\+/g, message: 'Nested quantifiers can cause regex DoS' },
  ];

  for (const { pattern, message } of dangerousPatterns) {
    if (pattern.test(script)) {
      return {
        behavior: 'ask',
        message: `sed regex contains potentially dangerous pattern: ${message}`,
        decisionReason: { type: 'safetyCheck', reason: message },
      };
    }
  }

  return { behavior: 'passthrough', message: 'No regex injection detected' };
}

/**
 * Check for address injection in sed commands.
 */
function validateAddressInjection(sed: SedCommand): PermissionResult {
  // Check if script has address prefix (e.g., '1s/.../.../')
  const addressPattern = /^\d+|^\$[;,]\d+|^[\/\.]\S+[\/\.]/;
  
  for (const dangerousPattern of DANGEROUS_SED_ADDRESS_PATTERNS) {
    if (dangerousPattern.test(sed.script)) {
      return {
        behavior: 'ask',
        message: 'sed address contains potentially dangerous variable interpolation',
        decisionReason: { type: 'safetyCheck', reason: 'Address injection detected' },
      };
    }
  }

  return { behavior: 'passthrough', message: 'No address injection detected' };
}

/**
 * Check for in-place editing without backup extension.
 */
function validateInplaceBackup(sed: SedCommand): PermissionResult {
  if (!sed.isInplaceEdit) {
    return { behavior: 'passthrough', message: 'Not an in-place edit' };
  }

  // Check if -i has a backup extension
  const hasBackupExtension = sed.flags.some((flag, i) => {
    if (flag === '-i' && i < sed.flags.length - 1) {
      const next = sed.flags[i + 1];
      return next && !next.startsWith('-');
    }
    return false;
  });

  if (!hasBackupExtension) {
    return {
      behavior: 'ask',
      message: 'sed -i without backup extension could corrupt original files. Consider using sed -i.bak for automatic backups.',
      decisionReason: { type: 'safetyCheck', reason: 'In-place edit without backup' },
    };
  }

  return { behavior: 'passthrough', message: 'In-place edit has backup extension' };
}

/**
 * Check for null characters in sed command.
 */
function validateNullCharacters(sed: SedCommand): PermissionResult {
  if (sed.script.includes('\0')) {
    return {
      behavior: 'deny',
      message: 'sed script contains null characters which can cause parsing errors',
      decisionReason: { type: 'safetyCheck', reason: 'Null character in sed script' },
    };
  }

  return { behavior: 'passthrough', message: 'No null characters' };
}

/**
 * Check for recursive path patterns in file targets.
 */
function validatePathTraversal(sed: SedCommand): PermissionResult {
  for (const file of sed.targetFiles) {
    if (file.includes('..')) {
      return {
        behavior: 'ask',
        message: `sed target contains path traversal: ${file}`,
        decisionReason: { type: 'safetyCheck', reason: 'Path traversal in sed target' },
      };
    }
  }

  return { behavior: 'passthrough', message: 'No path traversal detected' };
}

/**
 * Check for mixing wildcards with in-place editing (dangerous combination).
 */
function validateWildcardMix(sed: SedCommand): PermissionResult {
  if (!sed.isInplaceEdit || sed.targetFiles.length === 0) {
    return { behavior: 'passthrough', message: 'No wildcard+inplace combination' };
  }

  const hasWildcard = sed.targetFiles.some(file => 
    file.includes('*') || file.includes('?') || file.includes('[')
  );

  if (hasWildcard) {
    return {
      behavior: 'ask',
      message: 'sed -i with wildcards can affect multiple files and cause widespread corruption. Use explicit file list instead.',
      decisionReason: { type: 'safetyCheck', reason: 'Wildcard with in-place editing' },
    };
  }

  return { behavior: 'passthrough', message: 'No wildcard+inplace danger' };
}

// ============================================================================
// Main Sed Validator
// ============================================================================

const SED_VALIDATORS = [
  { fn: validateEmptyScript, checkId: SED_SECURITY_CHECK_IDS.SED_EMPTY_SCRIPT, name: 'empty_script' },
  { fn: validateSedFlags, checkId: SED_SECURITY_CHECK_IDS.SED_DANGEROUS_FLAGS, name: 'dangerous_flags' },
  { fn: validateRegexInjection, checkId: SED_SECURITY_CHECK_IDS.SED_REGEX_INJECTION, name: 'regex_injection' },
  { fn: validateAddressInjection, checkId: SED_SECURITY_CHECK_IDS.SED_ADDRESS_INJECTION, name: 'address_injection' },
  { fn: validateInplaceBackup, checkId: SED_SECURITY_CHECK_IDS.SED_MISSING_BACKUP_EXT, name: 'missing_backup' },
  { fn: validateNullCharacters, checkId: SED_SECURITY_CHECK_IDS.SED_NULL_CHARACTERS, name: 'null_characters' },
  { fn: validatePathTraversal, checkId: SED_SECURITY_CHECK_IDS.SED_RECURSIVE_PATH, name: 'path_traversal' },
  { fn: validateWildcardMix, checkId: SED_SECURITY_CHECK_IDS.SED_WILDCARD_MIX, name: 'wildcard_mix' },
];

/**
 * Check if a command is a sed command.
 */
export function isSedCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.startsWith('sed ') || trimmed.startsWith('sed\t');
}

/**
 * Main sed command verification function.
 */
export function verifySedCommand(command: string): BashVerificationResult {
  // First check if this is actually a sed command
  if (!isSedCommand(command)) {
    return {
      isSafe: true,
      behavior: 'passthrough',
      warnings: [],
      checkDetails: [],
    };
  }

  const warnings: string[] = [];
  const checkDetails: CheckDetail[] = [];
  let behavior: BashVerificationBehavior = 'allow';

  const sed = parseSedCommand(command);

  if (!sed) {
    return {
      isSafe: false,
      behavior: 'ask',
      warnings: ['Failed to parse sed command'],
      checkDetails: [{
        checkId: SED_SECURITY_CHECK_IDS.SED_INVALID_FLAGS,
        checkName: 'parse_error',
        passed: false,
        message: 'Could not parse sed command',
      }],
    };
  }

  for (const { fn, checkId, name } of SED_VALIDATORS) {
    const result = fn(sed);

    checkDetails.push({
      checkId,
      checkName: name,
      passed: result.behavior === 'passthrough' || result.behavior === 'allow',
      message: result.message,
    });

    if (result.behavior === 'ask') {
      warnings.push(result.message || `Security check '${name}' triggered`);
      if (behavior !== 'deny') {
        behavior = 'ask';
      }
    } else if (result.behavior === 'deny') {
      warnings.push(result.message || `Security check '${name}' denied`);
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
 * Quick check if a sed command is safe.
 */
export function isSedCommandSafe(command: string): boolean {
  const result = verifySedCommand(command);
  return result.isSafe;
}

/**
 * Get sed-specific warnings for a command.
 */
export function getSedWarnings(command: string): string[] {
  const result = verifySedCommand(command);
  return result.warnings;
}

/**
 * Suggest a safer alternative for dangerous sed commands.
 */
export function suggestSedAlternative(command: string): string | null {
  const sed = parseSedCommand(command);

  if (!sed) {
    return null;
  }

  // Suggest safer alternative for in-place editing
  if (sed.isInplaceEdit) {
    const flagsWithoutI = sed.flags.filter(f => f !== '-i' && f !== '--in-place');
    const safeFlags = flagsWithoutI.length > 0 ? flagsWithoutI.join(' ') + ' ' : '';
    
    if (sed.targetFiles.length > 0) {
      return `# Safer alternative for in-place sed:
${sed.baseCommand} ${safeFlags}'${sed.script}' ${sed.targetFiles.join(' ')} > /tmp/sed_tmp && mv /tmp/sed_tmp ${sed.targetFiles.join(' ')}`;
    }
  }

  return null;
}

// ============================================================================
// Integration with Bash Verification
// ============================================================================

/**
 * Extended validation context that includes sed parsing.
 */
export interface ExtendedValidationContext extends ValidationContext {
  isSedCommand: boolean;
  sedParsed?: SedCommand;
}

/**
 * Parse and extend validation context with sed-specific info.
 */
export function extendContextWithSed(context: ValidationContext): ExtendedValidationContext {
  const isSed = isSedCommand(context.originalCommand);
  
  return {
    ...context,
    isSedCommand: isSed,
    sedParsed: isSed ? parseSedCommand(context.originalCommand) : undefined,
  };
}
