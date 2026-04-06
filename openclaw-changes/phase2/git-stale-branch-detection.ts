/**
 * OpenClaw Git Stale Branch Detection System
 * 
 * This module provides automatic detection of stale git branches.
 * Stale branches are those that haven't been updated in a while and
 * may be candidates for cleanup.
 * 
 * Features:
 * - Configurable staleness thresholds
 * - Multi-criteria detection (date, commit, activity)
 * - Safe vs dangerous stale detection
 * - Suggested cleanup actions
 */

import { BashVerificationBehavior, PermissionResult, ValidationContext } from './bash-verification';

// ============================================================================
// Git Stale Branch Types
// ============================================================================

export interface StalenessCriteria {
  daysSinceLastCommit?: number;      // Branch inactive for X days
  daysSinceLastPush?: number;        // Not pushed in X days
  daysSinceLastMerge?: number;      // Not merged to target in X days
  aheadBy?: number;                  // Ahead of remote by X commits
  behindBy?: number;                 // Behind remote by X commits
  isOrphan?: boolean;                // No parent commit (unreachable)
  isDetached?: boolean;              // HEAD in detached state
  hasUnmergedChanges?: boolean;     // Has commits not in target branch
}

export interface BranchInfo {
  name: string;
  isRemote: boolean;
  isLocal: boolean;
  current?: boolean;                 // HEAD branch
  lastCommitDate?: Date;
  lastCommitHash?: string;
  lastCommitAuthor?: string;
  lastCommitMessage?: string;
  lastPushDate?: Date;
  lastMergeDate?: Date;
  trackingBranch?: string;
  aheadCount?: number;
  behindCount?: number;
  isStale: boolean;
  stalenessReasons: string[];
  stalenessScore: number;            // 0-100, higher = more stale
  isProtected: boolean;              // Don't delete without explicit confirmation
  protectionReason?: string;
}

export interface StaleBranchReport {
  repository: string;
  scannedAt: Date;
  totalBranches: number;
  staleBranches: BranchInfo[];
  healthyBranches: BranchInfo[];
  protectedBranches: BranchInfo[];
  summary: {
    totalStale: number;
    safeToDelete: number;
    needsReview: number;
    averageStaleness: number;
    oldestStaleBranch?: BranchInfo;
    mostStaleBranch?: BranchInfo;
  };
}

export interface GitStaleConfig {
  defaultStalenessCriteria: StalenessCriteria;
  protectedPatterns: string[];       // Branch names to never auto-delete
  protectedBranches: string[];        // Exact branch names to protect
  targetBranch?: string;             // Default merge target (e.g., main, master)
  includeRemote?: boolean;
  includeLocal?: boolean;
  maxStalenessScore?: number;        // Branches above this are "stale"
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: GitStaleConfig = {
  defaultStalenessCriteria: {
    daysSinceLastCommit: 90,
    daysSinceLastPush: 30,
    daysSinceLastMerge: 180,
    aheadBy: 0,                      // Ahead commits that were never pushed
    behindBy: 10,                    // Behind remote by significant amount
  },
  protectedPatterns: [
    '^main$',
    '^master$',
    '^develop$',
    '^dev$',
    '^staging$',
    '^production$',
    '^release.*',
    '.*-prod$',
    '.*-production$',
    '^hotfix.*',
    '^release.*',
  ],
  protectedBranches: [],
  targetBranch: 'main',
  includeRemote: true,
  includeLocal: true,
  maxStalenessScore: 50,
};

// ============================================================================
// Staleness Detection Logic
// ============================================================================

/**
 * Calculate staleness score for a branch.
 */
function calculateStalenessScore(
  branch: Partial<BranchInfo>,
  criteria: StalenessCriteria
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  
  const now = new Date();
  
  // Days since last commit
  if (criteria.daysSinceLastCommit && branch.lastCommitDate) {
    const daysSince = Math.floor(
      (now.getTime() - branch.lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    
    if (daysSince > criteria.daysSinceLastCommit) {
      const excess = daysSince - criteria.daysSinceLastCommit;
      const contribution = Math.min(40, Math.floor(excess / 10) * 5);
      score += contribution;
      reasons.push(`No commits for ${daysSince} days (+${contribution})`);
    }
  }
  
  // Days since last push
  if (criteria.daysSinceLastPush && branch.lastPushDate) {
    const daysSince = Math.floor(
      (now.getTime() - branch.lastPushDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    
    if (daysSince > criteria.daysSinceLastPush) {
      const excess = daysSince - criteria.daysSinceLastPush;
      const contribution = Math.min(25, Math.floor(excess / 7) * 3);
      score += contribution;
      reasons.push(`Not pushed for ${daysSince} days (+${contribution})`);
    }
  }
  
  // Ahead commits (never pushed)
  if (criteria.aheadBy !== undefined && branch.aheadCount !== undefined) {
    if (branch.aheadCount > criteria.aheadBy) {
      const contribution = Math.min(20, branch.aheadCount * 2);
      score += contribution;
      reasons.push(`${branch.aheadCount} unpushed commits (+${contribution})`);
    }
  }
  
  // Behind remote significantly
  if (criteria.behindBy !== undefined && branch.behindCount !== undefined) {
    if (branch.behindCount > criteria.behindBy) {
      const contribution = Math.min(15, Math.floor(branch.behindCount / 5) * 2);
      score += contribution;
      reasons.push(`${branch.behindCount} commits behind remote (+${contribution})`);
    }
  }
  
  // Orphan branch (no history)
  if (criteria.isOrphan && branch.lastCommitDate === undefined) {
    score += 30;
    reasons.push('Orphan branch (no history) (+30)');
  }
  
  return { score: Math.min(100, score), reasons };
}

/**
 * Check if branch name matches protection patterns.
 */
function isProtectedBranch(
  name: string,
  config: GitStaleConfig
): { protected: boolean; reason: string } {
  // Check exact matches first
  if (config.protectedBranches.includes(name)) {
    return { protected: true, reason: 'Explicitly protected branch name' };
  }
  
  // Check patterns
  for (const pattern of config.protectedPatterns) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(name)) {
        return { protected: true, reason: `Matches protection pattern: ${pattern}` };
      }
    } catch {
      // Invalid regex, skip
    }
  }
  
  return { protected: false, reason: '' };
}

// ============================================================================
// Git Command Execution
// ============================================================================

/**
 * Execute a git command and return output.
 */
async function execGitCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000 });
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

/**
 * Parse git branch output into branch info.
 */
function parseGitBranches(gitOutput: string, isRemote: boolean): Partial<BranchInfo>[] {
  if (!gitOutput) return [];
  
  const lines = gitOutput.split('\n').filter(line => line.trim());
  const branches: Partial<BranchInfo>[] = [];
  
  for (const line of lines) {
    const branch: Partial<BranchInfo> = {
      isRemote,
      isLocal: !isRemote,
      isStale: false,
      stalenessReasons: [],
      stalenessScore: 0,
    };
    
    // Parse current branch marker
    if (line.startsWith('* ')) {
      branch.current = true;
      branch.name = line.slice(2).trim();
    } else {
      branch.name = line.trim();
    }
    
    // Remove remote prefix for remote branches
    if (isRemote && branch.name.includes('/')) {
      // Keep the full name for remote branches
    }
    
    branches.push(branch);
  }
  
  return branches;
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Detect stale branches in a git repository.
 */
export async function detectStaleBranches(
  repoPath: string,
  config: Partial<GitStaleConfig> = {}
): Promise<StaleBranchReport> {
  const fullConfig: GitStaleConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    defaultStalenessCriteria: {
      ...DEFAULT_CONFIG.defaultStalenessCriteria,
      ...config.defaultStalenessCriteria,
    },
  };
  
  const branches: BranchInfo[] = [];
  
  // Fetch remote info first
  if (fullConfig.includeRemote) {
    await execGitCommand('git fetch --all', repoPath);
  }
  
  // Get local branches
  if (fullConfig.includeLocal) {
    const localResult = await execGitCommand(
      'git branch --format="%(refname:short)|%(HEAD)|%(upstream:short)|%(upstream:track)|%(committerdate:iso)|%(objectname:short)|%(authorname)|%(subject)"',
      repoPath
    );
    
    if (localResult.success && localResult.stdout) {
      const lines = localResult.stdout.split('\n').filter(Boolean);
      
      for (const line of lines) {
        const [name, headMarker, upstream, track, dateStr, hash, author, message] = line.split('|');
        
        if (!name) continue;
        
        const branch: BranchInfo = {
          name: name.trim(),
          isRemote: false,
          isLocal: true,
          current: headMarker?.trim() === '*',
          trackingBranch: upstream?.trim() || undefined,
          lastCommitDate: dateStr ? new Date(dateStr.trim()) : undefined,
          lastCommitHash: hash?.trim(),
          lastCommitAuthor: author?.trim(),
          lastCommitMessage: message?.trim(),
          aheadCount: track?.includes('ahead') ? parseInt(track.match(/ahead (\d+)/)?.[1] || '0') : 0,
          behindCount: track?.includes('behind') ? parseInt(track.match(/behind (\d+)/)?.[1] || '0') : 0,
          isStale: false,
          stalenessReasons: [],
          stalenessScore: 0,
          isProtected: false,
        };
        
        // Check protection
        const protection = isProtectedBranch(branch.name, fullConfig);
        branch.isProtected = protection.protected;
        branch.protectionReason = protection.reason;
        
        // Calculate staleness
        const staleness = calculateStalenessScore(branch, fullConfig.defaultStalenessCriteria);
        branch.stalenessScore = staleness.score;
        branch.stalenessReasons = staleness.reasons;
        branch.isStale = staleness.score >= (fullConfig.maxStalenessScore || 50);
        
        branches.push(branch);
      }
    }
  }
  
  // Get remote branches
  if (fullConfig.includeRemote) {
    const remoteResult = await execGitCommand(
      'git branch -r --format="%(refname:short)|%(committerdate:iso)|%(objectname:short)|%(authorname)|%(subject)"',
      repoPath
    );
    
    if (remoteResult.success && remoteResult.stdout) {
      const lines = remoteResult.stdout.split('\n').filter(Boolean);
      const seenRemotes = new Set<string>();
      
      for (const line of lines) {
        const [fullName, dateStr, hash, author, message] = line.split('|');
        
        if (!fullName) continue;
        
        // Skip HEAD pointers
        if (fullName.includes('HEAD ->')) continue;
        
        // Deduplicate
        if (seenRemotes.has(fullName.trim())) continue;
        seenRemotes.add(fullName.trim());
        
        const branch: BranchInfo = {
          name: fullName.trim(),
          isRemote: true,
          isLocal: false,
          lastCommitDate: dateStr ? new Date(dateStr.trim()) : undefined,
          lastCommitHash: hash?.trim(),
          lastCommitAuthor: author?.trim(),
          lastCommitMessage: message?.trim(),
          isStale: false,
          stalenessReasons: [],
          stalenessScore: 0,
          isProtected: false,
        };
        
        // Check protection
        const protection = isProtectedBranch(branch.name, fullConfig);
        branch.isProtected = protection.protected;
        branch.protectionReason = protection.reason;
        
        // Calculate staleness (remote branches use different thresholds)
        const remoteCriteria: StalenessCriteria = {
          ...fullConfig.defaultStalenessCriteria,
          daysSinceLastCommit: (fullConfig.defaultStalenessCriteria.daysSinceLastCommit || 90) * 2, // Double for remotes
        };
        
        const staleness = calculateStalenessScore(branch, remoteCriteria);
        branch.stalenessScore = staleness.score;
        branch.stalenessReasons = staleness.reasons;
        branch.isStale = staleness.score >= (fullConfig.maxStalenessScore || 50);
        
        branches.push(branch);
      }
    }
  }
  
  // Categorize branches
  const staleBranches = branches.filter(b => b.isStale);
  const healthyBranches = branches.filter(b => !b.isStale);
  const protectedBranches = branches.filter(b => b.isProtected);
  
  // Calculate summary
  const safeToDelete = staleBranches.filter(b => !b.isProtected);
  const needsReview = staleBranches.filter(b => b.isProtected);
  const avgStaleness = staleBranches.length > 0
    ? staleBranches.reduce((sum, b) => sum + b.stalenessScore, 0) / staleBranches.length
    : 0;
  
  // Find oldest and most stale
  let oldestStaleBranch: BranchInfo | undefined;
  let mostStaleBranch: BranchInfo | undefined;
  
  if (staleBranches.length > 0) {
    oldestStaleBranch = staleBranches.reduce((oldest, b) => {
      if (!oldest.lastCommitDate) return b;
      if (!b.lastCommitDate) return oldest;
      return b.lastCommitDate < oldest.lastCommitDate ? b : oldest;
    });
    
    mostStaleBranch = staleBranches.reduce((most, b) => 
      b.stalenessScore > most.stalenessScore ? b : most
    );
  }
  
  return {
    repository: repoPath,
    scannedAt: new Date(),
    totalBranches: branches.length,
    staleBranches,
    healthyBranches,
    protectedBranches,
    summary: {
      totalStale: staleBranches.length,
      safeToDelete: safeToDelete.length,
      needsReview: needsReview.length,
      averageStaleness: Math.round(avgStaleness),
      oldestStaleBranch,
      mostStaleBranch,
    },
  };
}

// ============================================================================
// Cleanup Suggestions
// ============================================================================

export interface CleanupSuggestion {
  branch: string;
  action: 'delete' | 'merge' | 'rebase' | 'push' | 'archive';
  reason: string;
  command?: string;
  danger: 'safe' | 'review' | 'dangerous';
  priority: number;
}

/**
 * Generate cleanup suggestions for stale branches.
 */
export function generateCleanupSuggestions(
  report: StaleBranchReport,
  options: {
    defaultTarget?: string;
    autoConfirm?: boolean;
  } = {}
): CleanupSuggestion[] {
  const suggestions: CleanupSuggestion[] = [];
  const target = options.defaultTarget || 'main';
  
  for (const branch of report.staleBranches) {
    // Skip protected branches unless explicitly requested
    if (branch.isProtected && !options.autoConfirm) {
      suggestions.push({
        branch: branch.name,
        action: 'archive',
        reason: `Protected branch: ${branch.protectionReason}`,
        danger: 'review',
        priority: 30,
      });
      continue;
    }
    
    // Branches with unpushed commits
    if (branch.aheadCount && branch.aheadCount > 0) {
      suggestions.push({
        branch: branch.name,
        action: 'push',
        reason: `${branch.aheadCount} commits ahead of remote`,
        command: `git push origin ${branch.name}`,
        danger: 'safe',
        priority: 70,
      });
    }
    
    // Branches that are behind - offer to rebase
    if (branch.behindCount && branch.behindCount > 5) {
      suggestions.push({
        branch: branch.name,
        action: 'rebase',
        reason: `${branch.behindCount} commits behind, consider rebasing on ${target}`,
        command: `git rebase ${target} ${branch.name}`,
        danger: 'review',
        priority: 50,
      });
    }
    
    // Delete suggestion for truly stale branches
    if (branch.stalenessScore >= 70 && !branch.isProtected) {
      suggestions.push({
        branch: branch.name,
        action: 'delete',
        reason: `Staleness score: ${branch.stalenessScore} - ${branch.stalenessReasons.join(', ')}`,
        command: branch.isRemote
          ? `git push origin --delete ${branch.name}`
          : `git branch -d ${branch.name}`,
        danger: branch.current ? 'dangerous' : 'safe',
        priority: branch.stalenessScore,
      });
    }
  }
  
  // Sort by priority
  return suggestions.sort((a, b) => b.priority - a.priority);
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a stale branch report for display.
 */
export function formatStaleBranchReport(report: StaleBranchReport): string {
  const lines: string[] = [];
  
  lines.push('╔════════════════════════════════════════════════════════════════╗');
  lines.push('║           Git Stale Branch Detection Report                     ║');
  lines.push('╚════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`📁 Repository: ${report.repository}`);
  lines.push(`⏰ Scanned: ${report.scannedAt.toLocaleString()}`);
  lines.push('');
  
  lines.push('📊 Summary:');
  lines.push(`   • Total branches: ${report.totalBranches}`);
  lines.push(`   • Stale branches: ${report.summary.totalStale}`);
  lines.push(`   • Safe to delete: ${report.summary.safeToDelete}`);
  lines.push(`   • Needs review: ${report.summary.needsReview}`);
  lines.push(`   • Average staleness: ${report.summary.averageStaleness}%`);
  lines.push('');
  
  if (report.staleBranches.length > 0) {
    lines.push('⚠️  Stale Branches:');
    lines.push('');
    
    for (const branch of report.staleBranches) {
      const staleIcon = branch.isProtected ? '🔒' : '🗑️';
      lines.push(`  ${staleIcon} ${branch.name}`);
      lines.push(`     Score: ${branch.stalenessScore}% | Last commit: ${branch.lastCommitDate?.toLocaleDateString() || 'Unknown'}`);
      
      if (branch.stalenessReasons.length > 0) {
        for (const reason of branch.stalenessReasons) {
          lines.push(`     • ${reason}`);
        }
      }
      
      if (branch.protectionReason) {
        lines.push(`     🔒 Protected: ${branch.protectionReason}`);
      }
      
      if (branch.current) {
        lines.push('     📍 Current branch');
      }
      
      lines.push('');
    }
  }
  
  if (report.summary.mostStaleBranch) {
    const most = report.summary.mostStaleBranch;
    lines.push('🔥 Most Stale: ' + most.name);
    lines.push(`   Last commit: ${most.lastCommitDate?.toLocaleDateString() || 'Unknown'}`);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Quick check if a repository has stale branches.
 */
export async function hasStaleBranches(
  repoPath: string,
  threshold: number = 50
): Promise<boolean> {
  const report = await detectStaleBranches(repoPath, {
    maxStalenessScore: threshold,
  });
  
  return report.summary.totalStale > 0;
}
