/**
 * OpenClaw Git History Skill Creator
 * 
 * This module analyzes git history to automatically generate reusable
 * skills based on commit patterns, repeated tasks, and successful
 * workflows.
 * 
 * Features:
 * - Analyze commit history for patterns
 * - Detect repeated workflows
 * - Extract commands and patterns from commits
 * - Generate skill files from git history
 * - Identify skill candidates from commit messages
 */

import { BashVerificationBehavior, PermissionResult, ValidationContext } from '../agents/bash-verification.js';

// ============================================================================
// Skill Creation Types
// ============================================================================

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: Date;
  message: string;
  fullMessage: string;
  filesChanged?: string[];
  additions?: number;
  deletions?: number;
}

export interface SkillCandidate {
  name: string;
  description: string;
  category: string;
  triggers: string[];
  commands: string[];
  confidence: number;           // 0-100
  sourceCommit?: string;
  sourcePattern?: string;
  usageCount: number;
  lastUsed?: Date;
  estimatedComplexity: 'simple' | 'moderate' | 'complex';
  requiredFiles?: string[];
  producedFiles?: string[];
}

export interface SkillTemplate {
  skillId: string;
  name: string;
  description: string;
  category: string;
  triggers: string[];
  instructions: string;
  examples?: string[];
  author?: string;
  createdFrom?: string;
  metadata?: Record<string, unknown>;
}

export interface GitHistoryAnalysis {
  repository: string;
  analyzedAt: Date;
  totalCommits: number;
  dateRange: { start: Date; end: Date };
  authors: string[];
  skillCandidates: SkillCandidate[];
  patterns: {
    name: string;
    description: string;
    occurrences: number;
    commits: string[];
  }[];
  recommendations: string[];
}

// ============================================================================
// Git Command Helpers
// ============================================================================

interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

async function execGitCommand(command: string, cwd: string): Promise<ExecResult> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60000 });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string };
    return {
      success: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || (error as Error).message,
    };
  }
}

// ============================================================================
// Commit Parsing
// ============================================================================

/**
 * Parse git log output into commit objects.
 */
function parseGitLog(output: string): GitCommit[] {
  if (!output) return [];
  
  const commits: GitCommit[] = [];
  const commitBlocks = output.split(/^=+$/m).filter(block => block.trim());
  
  for (const block of commitBlocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    
    // First line is hash and author
    const headerMatch = lines[0].match(/^([a-f0-9]+) \((.+)\) (.+)$/);
    if (!headerMatch) continue;
    
    const [, hash, author, dateStr] = headerMatch;
    const messageLines = lines.slice(1).filter(l => !l.startsWith('    '));
    const fullMessage = messageLines.join('\n').trim();
    const message = fullMessage.split('\n')[0].trim();
    
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      author: author.trim(),
      authorEmail: extractEmail(author),
      date: new Date(dateStr.trim()),
      message,
      fullMessage,
    });
  }
  
  return commits;
}

/**
 * Extract email from git author string.
 */
function extractEmail(authorString: string): string {
  const match = authorString.match(/<(.+)>/);
  return match ? match[1] : '';
}

/**
 * Get commit stats (files changed, additions, deletions).
 */
async function getCommitStats(
  hash: string,
  repoPath: string
): Promise<{ files: string[]; additions: number; deletions: number }> {
  const result = await execGitCommand(
    `git show ${hash} --stat --oneline --numstat`,
    repoPath
  );
  
  if (!result.success) {
    return { files: [], additions: 0, deletions: 0 };
  }
  
  const lines = result.stdout.split('\n');
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length === 3) {
      files.push(parts[2] || parts[1]);
      const add = parseInt(parts[0]) || 0;
      const del = parseInt(parts[1]) || 0;
      additions += add;
      deletions += del;
    }
  }
  
  return { files, additions, deletions };
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Common skill trigger patterns in commit messages.
 */
const SKILL_PATTERNS: { pattern: RegExp; name: string; category: string; extractCommands?: (msg: string) => string[] }[] = [
  // Code quality
  { pattern: /fix|bug|issue|error|broken/i, name: 'Bug Fix', category: 'fix' },
  { pattern: /refactor|restructure|clean up|reorganize/i, name: 'Refactoring', category: 'refactor' },
  { pattern: /test|spec|coverage|assert/i, name: 'Testing', category: 'testing' },
  { pattern: /docs?|documentation|readme|comment/i, name: 'Documentation', category: 'docs' },
  
  // Infrastructure
  { pattern: /deploy|staging|production|release/i, name: 'Deployment', category: 'deployment' },
  { pattern: /config|setting|env|variable/i, name: 'Configuration', category: 'config' },
  { pattern: /docker|container|kubernetes|k8s/i, name: 'Containerization', category: 'infrastructure' },
  { pattern: /ci\/cd|pipeline|github actions|gitlab/i, name: 'CI/CD', category: 'ci' },
  
  // Database
  { pattern: /migration|schema|table|database|db/i, name: 'Database Migration', category: 'database' },
  { pattern: /query|sql|mongo|postgres|mysql/i, name: 'Database Query', category: 'database' },
  
  // Security
  { pattern: /security|vulnerability|cve|exploit|injection/i, name: 'Security Fix', category: 'security' },
  { pattern: /auth|login|permission|acl|oauth/i, name: 'Authentication', category: 'security' },
  
  // Performance
  { pattern: /performance|speed|optimize|cache|benchmark/i, name: 'Performance', category: 'performance' },
  { pattern: /memory|leak|gc|heap|resource/i, name: 'Resource Management', category: 'performance' },
  
  // Development
  { pattern: /feature|enhancement|improve|add/i, name: 'Feature Development', category: 'feature' },
  { pattern: /api|endpoint|rest|graphql|grpc/i, name: 'API Development', category: 'api' },
  { pattern: /frontend|ui|interface|component|react|vue|angular/i, name: 'Frontend', category: 'frontend' },
  { pattern: /backend|server|service|microservice/i, name: 'Backend', category: 'backend' },
  
  // Tool-specific
  { pattern: /eslint|prettier|formatter|lint/i, name: 'Code Formatting', category: 'tool' },
  { pattern: /webpack|vite|rollup|bundler/i, name: 'Bundling', category: 'tool' },
  { pattern: /git|branch|merge|pull request|pr/i, name: 'Version Control', category: 'vcs' },
];

/**
 * Extract commands from commit message.
 */
function extractCommandsFromMessage(message: string): string[] {
  const commands: string[] = [];
  
  // Look for code blocks
  const codeBlockPattern = /```[\s\S]*?```/g;
  const codeBlocks = message.match(codeBlockPattern);
  if (codeBlocks) {
    for (const block of codeBlocks) {
      const lines = block.replace(/```\w*/g, '').trim().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('$ ') || trimmed.startsWith('# ')) {
          commands.push(trimmed.slice(2));
        }
      }
    }
  }
  
  // Look for inline commands
  const commandPatterns = [
    /(?:run|execute|use|call)\s+`([^`]+)`/gi,
    /`([^`]+)`/g,
  ];
  
  for (const pattern of commandPatterns) {
    let match;
    while ((match = pattern.exec(message)) !== null) {
      const cmd = match[1].trim();
      if (cmd && !commands.includes(cmd)) {
        commands.push(cmd);
      }
    }
  }
  
  return commands;
}

// ============================================================================
// Skill Generation
// ============================================================================

/**
 * Analyze git history and generate skill candidates.
 */
export async function analyzeGitHistory(
  repoPath: string,
  options: {
    maxCommits?: number;
    author?: string;
    since?: Date;
    until?: Date;
    pattern?: string;
  } = {}
): Promise<GitHistoryAnalysis> {
  const maxCommits = options.maxCommits || 500;
  
  // Build git log command
  let logFormat = '%H%n%an%n%ae%n%at%n%s%n%b%n---';
  let gitArgs = ['log', `--format=${logFormat}`, `-${maxCommits}`];
  
  if (options.author) {
    gitArgs.push(`--author=${options.author}`);
  }
  if (options.since) {
    gitArgs.push(`--since=${options.since.toISOString()}`);
  }
  if (options.until) {
    gitArgs.push(`--until=${options.until.toISOString()}`);
  }
  if (options.pattern) {
    gitArgs.push(`--grep=${options.pattern}`);
  }
  
  const result = await execGitCommand(gitArgs.join(' '), repoPath);
  
  if (!result.success) {
    return {
      repository: repoPath,
      analyzedAt: new Date(),
      totalCommits: 0,
      dateRange: { start: new Date(), end: new Date() },
      authors: [],
      skillCandidates: [],
      patterns: [],
      recommendations: [],
    };
  }
  
  // Parse commits
  const commits = parseGitLog(result.stdout);
  
  // Get file stats for each commit (limit to recent 50 for performance)
  const recentCommits = commits.slice(0, 50);
  await Promise.all(recentCommits.map(async (commit) => {
    const stats = await getCommitStats(commit.hash, repoPath);
    commit.filesChanged = stats.files;
    commit.additions = stats.additions;
    commit.deletions = stats.deletions;
  }));
  
  // Detect patterns
  const patternOccurrences = new Map<string, { name: string; category: string; commits: Set<string> }>();
  
  for (const commit of commits) {
    for (const { pattern, name, category } of SKILL_PATTERNS) {
      if (pattern.test(commit.message)) {
        const key = `${category}:${name}`;
        if (!patternOccurrences.has(key)) {
          patternOccurrences.set(key, { name, category, commits: new Set() });
        }
        patternOccurrences.get(key)!.commits.add(commit.shortHash);
      }
    }
  }
  
  const patterns = Array.from(patternOccurrences.entries()).map(([key, data]) => ({
    name: data.name,
    category: data.category,
    description: `${data.name} workflow (${data.category})`,
    occurrences: data.commits.size,
    commits: Array.from(data.commits),
  })).sort((a, b) => b.occurrences - a.occurrences);
  
  // Generate skill candidates
  const skillCandidates = generateSkillCandidates(commits, patterns);
  
  // Get unique authors
  const authors = [...new Set(commits.map(c => c.author))];
  
  // Date range
  const dateRange = {
    start: commits.length > 0 ? commits[commits.length - 1].date : new Date(),
    end: commits.length > 0 ? commits[0].date : new Date(),
  };
  
  // Recommendations
  const recommendations = generateRecommendations(patterns, commits);
  
  return {
    repository: repoPath,
    analyzedAt: new Date(),
    totalCommits: commits.length,
    dateRange,
    authors,
    skillCandidates,
    patterns: patterns.slice(0, 20),
    recommendations,
  };
}

/**
 * Generate skill candidates from commits and patterns.
 */
function generateSkillCandidates(
  commits: GitCommit[],
  patterns: { name: string; category: string; description: string; occurrences: number; commits: string[] }[]
): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];
  const seenCategories = new Set<string>();
  
  // High-occurrence patterns become skill candidates
  for (const pattern of patterns) {
    if (pattern.occurrences < 3) continue;
    
    const categoryKey = pattern.category;
    if (seenCategories.has(categoryKey)) continue;
    seenCategories.add(categoryKey);
    
    const patternCommits = commits.filter(c => pattern.commits.includes(c.shortHash));
    
    candidates.push({
      name: pattern.name,
      description: `Workflow for ${pattern.name.toLowerCase()} tasks`,
      category: pattern.category,
      triggers: generateTriggers(pattern.name, pattern.category),
      commands: extractCommonCommands(patternCommits),
      confidence: Math.min(95, 50 + pattern.occurrences * 5),
      sourcePattern: pattern.name,
      usageCount: pattern.occurrences,
      estimatedComplexity: pattern.occurrences > 10 ? 'simple' : pattern.occurrences > 5 ? 'moderate' : 'complex',
    });
  }
  
  // Look for repeat commit messages (repeated tasks)
  const messageFrequency = new Map<string, GitCommit[]>();
  for (const commit of commits) {
    const key = commit.message.toLowerCase().trim();
    if (!messageFrequency.has(key)) {
      messageFrequency.set(key, []);
    }
    messageFrequency.get(key)!.push(commit);
  }
  
  for (const [message, sameMessages] of messageFrequency) {
    if (sameMessages.length < 3) continue;
    if (message.length < 10) continue;
    
    const commands = extractCommandsFromMessage(sameMessages[0].fullMessage);
    if (commands.length === 0) continue;
    
    candidates.push({
      name: generateNameFromMessage(message),
      description: message,
      category: detectCategory(message),
      triggers: [message.split(' ')[0].toLowerCase()],
      commands,
      confidence: Math.min(90, 40 + sameMessages.length * 10),
      sourceCommit: sameMessages[0].shortHash,
      usageCount: sameMessages.length,
      estimatedComplexity: 'simple',
    });
  }
  
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Generate trigger phrases for a skill.
 */
function generateTriggers(name: string, category: string): string[] {
  const triggers: string[] = [name.toLowerCase()];
  
  const prefixes: Record<string, string[]> = {
    fix: ['fix', 'bug', 'issue', 'problem'],
    refactor: ['refactor', 'restructure', 'clean'],
    testing: ['test', 'spec', 'verify'],
    docs: ['doc', 'readme', 'document'],
    deployment: ['deploy', 'release', 'staging', 'production'],
    config: ['config', 'setting', 'configure'],
    infrastructure: ['docker', 'container', 'k8s'],
    ci: ['ci', 'cd', 'pipeline', 'github actions'],
    database: ['db', 'database', 'migration', 'schema'],
    security: ['security', 'auth', 'permission'],
    performance: ['performance', 'optimize', 'speed'],
    feature: ['feature', 'add', 'implement', 'enhance'],
    api: ['api', 'endpoint', 'rest', 'graphql'],
    frontend: ['frontend', 'ui', 'component', 'react'],
    backend: ['backend', 'server', 'service'],
    tool: ['tool', 'formatter', 'linter'],
    vcs: ['git', 'branch', 'merge'],
  };
  
  const categoryPrefixes = prefixes[category] || [];
  for (const prefix of categoryPrefixes) {
    triggers.push(`${prefix} ${name.toLowerCase()}`);
  }
  
  return [...new Set(triggers)];
}

/**
 * Extract common commands from commits.
 */
function extractCommonCommands(commits: GitCommit[]): string[] {
  const allCommands: string[] = [];
  
  for (const commit of commits.slice(0, 20)) {
    const commands = extractCommandsFromMessage(commit.fullMessage);
    allCommands.push(...commands);
  }
  
  // Count frequency
  const frequency = new Map<string, number>();
  for (const cmd of allCommands) {
    frequency.set(cmd, (frequency.get(cmd) || 0) + 1);
  }
  
  // Return most common
  return Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cmd]) => cmd);
}

/**
 * Generate a skill name from commit message.
 */
function generateNameFromMessage(message: string): string {
  const words = message.split(/\s+/).slice(0, 4);
  const capitalized = words.map(w => 
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  );
  return capitalized.join('');
}

/**
 * Detect category from message.
 */
function detectCategory(message: string): string {
  for (const { pattern, category } of SKILL_PATTERNS) {
    if (pattern.test(message)) {
      return category;
    }
  }
  return 'other';
}

/**
 * Generate recommendations based on analysis.
 */
function generateRecommendations(
  patterns: { name: string; occurrences: number }[],
  commits: GitCommit[]
): string[] {
  const recommendations: string[] = [];
  
  // Recommend automation for frequent patterns
  const frequentPatterns = patterns.filter(p => p.occurrences > 10);
  for (const pattern of frequentPatterns) {
    recommendations.push(
      `Consider automating ${pattern.name.toLowerCase()} tasks (${pattern.occurrences} occurrences)`
    );
  }
  
  // Recommend skill creation for patterns
  if (patterns.length > 5) {
    recommendations.push(
      `Create skills for the top ${Math.min(5, patterns.length)} most common patterns`
    );
  }
  
  // Check for consistent commit patterns
  if (commits.length > 50) {
    recommendations.push(
      'Project shows consistent activity - consider creating a "project workflow" skill'
    );
  }
  
  return recommendations;
}

// ============================================================================
// Skill File Generation
// ============================================================================

/**
 * Generate a skill file from a candidate.
 */
export function generateSkillFile(candidate: SkillCandidate): SkillTemplate {
  const skillId = candidate.name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  
  const instructions = generateInstructions(candidate);
  
  return {
    skillId,
    name: candidate.name,
    description: candidate.description,
    category: candidate.category,
    triggers: candidate.triggers,
    instructions,
    examples: candidate.commands.slice(0, 3),
    createdFrom: 'git-history',
    metadata: {
      confidence: candidate.confidence,
      usageCount: candidate.usageCount,
      estimatedComplexity: candidate.estimatedComplexity,
      sourceCommit: candidate.sourceCommit,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Generate skill instructions from candidate.
 */
function generateInstructions(candidate: SkillCandidate): string {
  const lines: string[] = [];
  
  lines.push(`# ${candidate.name}`);
  lines.push('');
  lines.push(candidate.description);
  lines.push('');
  lines.push('## When to Use');
  lines.push('');
  lines.push(`Use this skill when you need to: ${candidate.triggers.slice(0, 3).join(', ')}.`);
  lines.push('');
  
  if (candidate.commands.length > 0) {
    lines.push('## Common Commands');
    lines.push('');
    for (const cmd of candidate.commands) {
      lines.push(`\`${cmd}\``);
    }
    lines.push('');
  }
  
  lines.push('## Notes');
  lines.push('');
  lines.push(`- Confidence: ${candidate.confidence}%`);
  lines.push(`- Complexity: ${candidate.estimatedComplexity}`);
  lines.push(`- Used ${candidate.usageCount} times in git history`);
  
  return lines.join('\n');
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format analysis report for display.
 */
export function formatAnalysisReport(analysis: GitHistoryAnalysis): string {
  const lines: string[] = [];
  
  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('║        Git History Skill Creator - Analysis Report              ║');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`📁 Repository: ${analysis.repository}`);
  lines.push(`📅 Analysis Period: ${analysis.dateRange.start.toLocaleDateString()} - ${analysis.dateRange.end.toLocaleDateString()}`);
  lines.push(`📊 Total Commits Analyzed: ${analysis.totalCommits}`);
  lines.push(`👥 Authors: ${analysis.authors.join(', ')}`);
  lines.push('');
  
  if (analysis.patterns.length > 0) {
    lines.push('🔄 Detected Patterns:');
    lines.push('');
    for (const pattern of analysis.patterns.slice(0, 10)) {
      lines.push(`  • ${pattern.name} (${pattern.occurrences} occurrences)`);
    }
    lines.push('');
  }
  
  if (analysis.skillCandidates.length > 0) {
    lines.push('✨ Skill Candidates:');
    lines.push('');
    for (const candidate of analysis.skillCandidates.slice(0, 5)) {
      lines.push(`  📦 ${candidate.name}`);
      lines.push(`     Confidence: ${candidate.confidence}% | Category: ${candidate.category}`);
      lines.push(`     Triggers: ${candidate.triggers.slice(0, 3).join(', ')}`);
      lines.push('');
    }
  }
  
  if (analysis.recommendations.length > 0) {
    lines.push('💡 Recommendations:');
    lines.push('');
    for (const rec of analysis.recommendations) {
      lines.push(`  • ${rec}`);
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Format a skill file for writing.
 */
export function formatSkillFile(skill: SkillTemplate): string {
  const lines: string[] = [];
  
  lines.push('# SKILL.md - ' + skill.name);
  lines.push('');
  lines.push(skill.instructions);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*This skill was automatically generated from git history*`);
  lines.push(`*Created: ${new Date().toISOString()}*`);
  
  return lines.join('\n');
}

// ============================================================================
// Quick Analysis
// ============================================================================

/**
 * Quick analysis - just get skill candidates without full report.
 */
export async function quickSkillAnalysis(repoPath: string): Promise<SkillCandidate[]> {
  const analysis = await analyzeGitHistory(repoPath, { maxCommits: 200 });
  return analysis.skillCandidates;
}

/**
 * Generate skills from repository history.
 */
export async function generateSkillsFromHistory(
  repoPath: string,
  outputDir: string,
  options: {
    minConfidence?: number;
    maxSkills?: number;
  } = {}
): Promise<SkillTemplate[]> {
  const analysis = await analyzeGitHistory(repoPath);
  
  const skills = analysis.skillCandidates
    .filter(c => c.confidence >= (options.minConfidence || 50))
    .slice(0, options.maxSkills || 10)
    .map(c => generateSkillFile(c));
  
  return skills;
}
