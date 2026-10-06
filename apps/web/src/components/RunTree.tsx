import type { ReactNode } from 'react';
import { OutcomeBadge } from './Badge';
import { formatDuration, formatTokens } from './format';

export interface RunTreeNode {
  id: string;
  label: string;
  model: string | null;
  effort: string | null;
  durationMs: number;
  tokens: number;
  outcome: string | null;
  children: RunTreeNode[];
}

function Node({ node }: { node: RunTreeNode }): ReactNode {
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        <span className="font-medium">{node.label}</span>
        {(node.model || node.effort) && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{[node.model, node.effort].filter(Boolean).join(' · ')}</span>
        )}
        <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatDuration(node.durationMs)}</span>
        <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">{formatTokens(node.tokens)} tokens</span>
        {node.outcome && <OutcomeBadge outcome={node.outcome} />}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-3 border-l border-zinc-200 pl-3 dark:border-zinc-700">
          {node.children.map((c) => (
            <Node key={c.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Parent -> child tree of a turn's agent runs (the main agent is the root). Plain HTML, no JS. */
export function RunTree({ root }: { root: RunTreeNode }) {
  return (
    <ul role="tree" aria-label="Agent run tree" className="text-sm">
      <Node node={root} />
    </ul>
  );
}
