import { and, eq, sql } from 'drizzle-orm';
import { projects, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, optionalId, parse } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor } from './types';

export interface AdminProjectRow {
  id: string;
  key: string;
  hashed: boolean;
  displayName: string | null;
  teamId: string | null;
  teamName: string | null;
  turns30d: number;
  lastSeenMs: number;
}

/**
 * Projects with their turn count over the last 30 days. Counts come from agg_turns_by_project, which
 * gives admins company totals in both visibility modes and never returns user ids.
 */
export async function listAdminProjects(tx: Tx, companyId: string, now = new Date()): Promise<AdminProjectRow[]> {
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const list = await rows<{ id: string; key: string; display_name: string | null; team_id: string | null; team_name: string | null; turns: number | string | null; last_seen_at: Date | string }>(
    tx,
    sql`select p.id, p.key, p.display_name, p.team_id, t.name as team_name, a.turns, p.last_seen_at
        from projects p left join teams t on t.id = p.team_id
        left join agg_turns_by_project(${from}::timestamptz, ${now.toISOString()}::timestamptz) a on a.project_id = p.id
        where p.company_id = ${companyId}::uuid
        order by coalesce(a.turns, 0) desc, coalesce(p.display_name, p.key)`,
  );
  return list.map((p) => ({
    id: p.id,
    key: p.key,
    hashed: p.key.startsWith('sha256:'),
    displayName: p.display_name,
    teamId: p.team_id,
    teamName: p.team_name,
    turns30d: Number(p.turns ?? 0),
    lastSeenMs: new Date(p.last_seen_at).getTime(),
  }));
}

async function loadProject(tx: Tx, companyId: string, projectId: string) {
  const [p] = await tx
    .select({ key: projects.key, displayName: projects.displayName, teamId: projects.teamId })
    .from(projects)
    .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
  if (!p) throw new AdminError('Project not found.');
  return p;
}

/** Empty name = show the key again. */
export async function setProjectName(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can name projects.');
  const { projectId, displayName } = parse(z.object({ projectId: id, displayName: z.string().trim().max(120, 'at most 120 characters') }), input);
  const p = await loadProject(tx, actor.companyId, projectId);
  const next = displayName || null;
  if (p.displayName === next) return 'No changes.';
  await tx.update(projects).set({ displayName: next }).where(and(eq(projects.companyId, actor.companyId), eq(projects.id, projectId)));
  await audit(tx, actor, 'project.rename', `project:${projectId}`, { before: p.displayName, after: next });
  return next ? 'Display name saved.' : 'Display name cleared.';
}

/** Project → team mapping: first rule of turn attribution, for new turns (BRIEF §4). */
export async function setProjectTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can map projects to teams.');
  const { projectId, teamId } = parse(z.object({ projectId: id, teamId: optionalId }), input);
  const p = await loadProject(tx, actor.companyId, projectId);
  if (p.teamId === teamId) return 'No changes.';
  if (teamId) {
    const [t] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, teamId)));
    ensure(t, 'Team not found.');
  }
  await tx.update(projects).set({ teamId }).where(and(eq(projects.companyId, actor.companyId), eq(projects.id, projectId)));
  await audit(tx, actor, teamId ? 'project.map' : 'project.unmap', `project:${projectId}`, { before: p.teamId, after: teamId });
  return teamId ? 'Project mapped. New turns are attributed to this team.' : 'Mapping removed.';
}
