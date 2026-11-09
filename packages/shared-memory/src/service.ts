import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  AUTHORITATIVE_STATUSES,
  DomainError,
  EXCLUDED_STATUSES,
  forbidden,
  KNOWLEDGE_STATUSES,
  notFound,
  PROVISIONAL_STATUSES,
  type EvidenceInput,
  type KnowledgeAction,
  type KnowledgeRecord,
  type KnowledgeStatus,
  type PublishKnowledge,
  type SearchKnowledge,
} from "@agentmesh/contracts";
import {
  auditLog,
  events,
  knowledgeConsumption,
  knowledgeEvidence,
  knowledgeRecords,
  knowledgeRelations,
  knowledgeSubscriptions,
  taskDependencies,
  tasks,
  type Db,
  type DbOrTx,
} from "@agentmesh/database";
import { defaultRedactor } from "@agentmesh/observability";
import { cosine, HashingEmbedder, toPgVector, tokenize, type Embedder } from "./embedding.ts";
import { pathsOverlap } from "./paths.ts";

type Row = typeof knowledgeRecords.$inferSelect;

/** Who is reading or writing. Authorization is evaluated against this, before ranking. */
export type Viewer =
  | { kind: "user"; actor: string; role: "admin" | "operator" | "viewer"; projectIds: string[] | null }
  | { kind: "agent"; actor: string; agentId: string; projectId: string; taskId: string; runId: string | null };

export interface PublishSource {
  projectId: string;
  actor: string;
  agentId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  commitSha?: string | null;
}

export interface SearchHit {
  record: KnowledgeRecord;
  score: number;
  /** Signals that contributed, for explainability in the explorer. */
  signals: { fts: number; semantic: number; path: number; dependency: number; relation: number; trust: number; recency: number };
  authoritative: boolean;
}

const TRUST: Record<KnowledgeStatus, number> = { accepted: 1, verified: 0.9, evidenced: 0.55, proposed: 0.4, disputed: 0.15, stale: 0.1, superseded: 0.05, rejected: 0 };
const VERIFIABLE_EVIDENCE = new Set(["run", "artifact", "validation", "test", "commit", "file"]);
const NEAR_DUP_THRESHOLD = 0.93;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class KnowledgeService {
  constructor(
    private db: Db,
    private embedder: Embedder = new HashingEmbedder(),
  ) {}

  // ------------------------------------------------------------------ publish

  /**
   * Publishes a discovery: provenance + evidence recorded, deduplicated against existing
   * records (exact fingerprint, then near-duplicate by embedding), scope classified,
   * stored as provisional, indexed (tsvector + vector), subscribers notified.
   * Agent output is never stored as verified/accepted.
   */
  async publish(input: PublishKnowledge, src: PublishSource): Promise<{ record: KnowledgeRecord; deduplicated: false | "exact" | "near" }> {
    const clean = defaultRedactor.redactDeep(input) as PublishKnowledge;
    const fingerprint = fingerprintOf(clean.type, clean.statement);
    const embedding = this.embedder.embed(`${clean.title}\n${clean.statement}\n${clean.affectedPaths.join(" ")}`);
    const out = await this.db.transaction(async (tx) => {
      const dup = await this.findDuplicate(tx, src.projectId, clean.type, fingerprint, embedding);
      if (dup) {
        await this.addEvidence(tx, dup.row.id, clean.evidence, src.actor, src.commitSha ?? null);
        if (src.runId) await this.addEvidence(tx, dup.row.id, [{ kind: "run", reference: src.runId, excerpt: "corroborating publication" }], src.actor, src.commitSha ?? null);
        const promoted = dup.row.status === "proposed" && clean.evidence.some((e) => VERIFIABLE_EVIDENCE.has(e.kind)) ? "evidenced" : dup.row.status;
        const [u] = await tx
          .update(knowledgeRecords)
          .set({ status: promoted, version: sql`${knowledgeRecords.version} + 1`, updatedAt: new Date() })
          .where(eq(knowledgeRecords.id, dup.row.id))
          .returning();
        await this.log(tx, u!, "knowledge.deduplicated", src.actor, { match: dup.kind, by: src.actor });
        return { row: u!, deduplicated: dup.kind };
      }
      const scope = clean.scope ?? (clean.type === "task_context" ? "task" : clean.affectedPaths.length ? "paths" : "project");
      const status: KnowledgeStatus = clean.evidence.some((e) => VERIFIABLE_EVIDENCE.has(e.kind)) ? "evidenced" : "proposed";
      const [row] = await tx
        .insert(knowledgeRecords)
        .values({
          projectId: src.projectId,
          repositoryId: src.projectId,
          type: clean.type,
          title: clean.title,
          statement: clean.statement,
          status,
          scope,
          allowedAgentIds: clean.allowedAgentIds ?? null,
          confidence: clean.confidence,
          tags: clean.tags,
          sourceAgentId: src.agentId ?? null,
          sourceRunId: src.runId ?? null,
          sourceTaskId: src.taskId ?? null,
          sourceActor: src.actor,
          sourceCommitSha: src.commitSha ?? null,
          affectedPaths: clean.affectedPaths,
          fingerprint,
          embedding,
        })
        .returning();
      await this.addEvidence(tx, row!.id, clean.evidence, src.actor, src.commitSha ?? null);
      if (src.runId) await this.addEvidence(tx, row!.id, [{ kind: "run", reference: src.runId, excerpt: "originating run" }], src.actor, src.commitSha ?? null);
      for (const r of clean.relations) {
        const [target] = await tx.select().from(knowledgeRecords).where(and(eq(knowledgeRecords.id, r.targetId), eq(knowledgeRecords.projectId, src.projectId)));
        if (!target) throw new DomainError("INVALID_RELATION", `Related record ${r.targetId} not found in this project`, 422);
        await tx.insert(knowledgeRelations).values({ fromId: row!.id, toId: r.targetId, relation: r.relation, createdBy: src.actor }).onConflictDoNothing();
        // Supersession by an agent is only a proposal; it takes effect when the new record is verified/accepted.
      }
      await this.log(tx, row!, "knowledge.published", src.actor, { type: row!.type, title: row!.title, status: row!.status, scope });
      return { row: row!, deduplicated: false as const };
    });
    await this.notifySubscribers(out.row);
    return { record: await this.toRecord(out.row), deduplicated: out.deduplicated };
  }

  private async findDuplicate(tx: DbOrTx, projectId: string, type: string, fingerprint: string, embedding: number[]): Promise<{ row: Row; kind: "exact" | "near" } | null> {
    const live = ne(knowledgeRecords.status, "rejected");
    const [exact] = await tx.select().from(knowledgeRecords).where(and(eq(knowledgeRecords.projectId, projectId), eq(knowledgeRecords.fingerprint, fingerprint), live)).limit(1);
    if (exact) return { row: exact, kind: "exact" };
    const [near] = await tx
      .select({ row: knowledgeRecords, distance: sql<number>`${knowledgeRecords.embedding} <=> ${toPgVector(embedding)}::vector` })
      .from(knowledgeRecords)
      .where(and(eq(knowledgeRecords.projectId, projectId), eq(knowledgeRecords.type, type), inArray(knowledgeRecords.status, ["proposed", "evidenced", "verified", "accepted"])))
      .orderBy(sql`${knowledgeRecords.embedding} <=> ${toPgVector(embedding)}::vector`)
      .limit(1);
    if (near && 1 - Number(near.distance) >= NEAR_DUP_THRESHOLD) return { row: near.row, kind: "near" };
    return null;
  }

  private async addEvidence(tx: DbOrTx, knowledgeId: string, evidence: EvidenceInput[], actor: string, commitSha: string | null) {
    if (!evidence.length) return;
    await tx.insert(knowledgeEvidence).values(evidence.map((e) => ({ knowledgeId, kind: e.kind, reference: e.reference, excerpt: e.excerpt ?? "", addedBy: actor, commitSha })));
  }

  // ------------------------------------------------------------------ read

  async get(id: string, viewer: Viewer, via: "get" | null = "get") {
    const [row] = await this.db.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, id));
    if (!row || !(await this.visible(row, viewer))) throw notFound("Knowledge record", id);
    const evidence = await this.db.select().from(knowledgeEvidence).where(eq(knowledgeEvidence.knowledgeId, id)).orderBy(knowledgeEvidence.createdAt);
    const relations = await this.db
      .select()
      .from(knowledgeRelations)
      .where(or(eq(knowledgeRelations.fromId, id), eq(knowledgeRelations.toId, id)));
    const consumers = await this.db
      .select({ taskId: knowledgeConsumption.taskId, runId: knowledgeConsumption.runId, agentId: knowledgeConsumption.agentId, via: knowledgeConsumption.via, version: knowledgeConsumption.knowledgeVersion, at: knowledgeConsumption.createdAt, snapshotId: knowledgeConsumption.contextSnapshotId })
      .from(knowledgeConsumption)
      .where(eq(knowledgeConsumption.knowledgeId, id))
      .orderBy(desc(knowledgeConsumption.id))
      .limit(200);
    if (via && viewer.kind === "agent") await this.recordConsumption([row], viewer, via);
    return {
      record: await this.toRecord(row),
      authoritative: AUTHORITATIVE_STATUSES.includes(row.status),
      evidence: evidence.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      relations: relations.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      consumers: consumers.map((c) => ({ ...c, at: c.at.toISOString() })),
    };
  }

  async list(projectId: string, filters: { types?: string[]; statuses?: string[]; limit?: number }) {
    const conds = [eq(knowledgeRecords.projectId, projectId)];
    if (filters.types?.length) conds.push(inArray(knowledgeRecords.type, filters.types));
    if (filters.statuses?.length) conds.push(inArray(knowledgeRecords.status, filters.statuses as KnowledgeStatus[]));
    const rows = await this.db.select().from(knowledgeRecords).where(and(...conds)).orderBy(desc(knowledgeRecords.updatedAt)).limit(filters.limit ?? 200);
    return Promise.all(rows.map((r) => this.toRecord(r)));
  }

  /**
   * Hybrid retrieval. Order of operations: (1) authorization + freshness filters in SQL,
   * (2) candidate generation from full-text, semantic, path, dependency and relationship
   * signals, (3) deterministic ranking with trust and recency, ties broken by id.
   */
  async search(projectId: string, q: SearchKnowledge, viewer: Viewer, opts: { recordAs?: "search" | "context" | "refresh" | null; snapshotId?: string } = {}): Promise<SearchHit[]> {
    this.assertProject(viewer, projectId);
    const statuses = q.statuses?.length ? q.statuses : KNOWLEDGE_STATUSES.filter((s) => !EXCLUDED_STATUSES.includes(s));
    const conds = [eq(knowledgeRecords.projectId, projectId), inArray(knowledgeRecords.status, statuses)];
    if (q.types.length) conds.push(inArray(knowledgeRecords.type, q.types));
    if (viewer.kind === "agent") {
      conds.push(or(isNull(knowledgeRecords.allowedAgentIds), sql`${knowledgeRecords.allowedAgentIds} @> ${JSON.stringify([viewer.agentId])}::jsonb`)!);
    }
    const query = q.query.trim();
    const qvec = query ? this.embedder.embed(`${query} ${q.paths.join(" ")}`) : null;
    // OR-of-terms: ts_rank_cd rewards records matching more terms; AND semantics would starve long task queries.
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 40);
    const tsq = terms.length ? sql`to_tsquery('english', ${terms.join(" | ")})` : null;
    // Bound the working set; FTS/semantic candidates are pulled explicitly so recall is not limited by recency.
    const base = await this.db.select().from(knowledgeRecords).where(and(...conds)).orderBy(desc(knowledgeRecords.updatedAt)).limit(500);
    const ftsRows = tsq
      ? await this.db
          .select({ id: knowledgeRecords.id, rank: sql<number>`ts_rank_cd(${knowledgeRecords.search}, ${tsq})` })
          .from(knowledgeRecords)
          .where(and(...conds, sql`${knowledgeRecords.search} @@ ${tsq}`))
          .limit(200)
      : [];
    const fts = new Map(ftsRows.map((r) => [r.id, Number(r.rank)]));
    const extraIds = ftsRows.map((r) => r.id).filter((id) => !base.some((b) => b.id === id));
    const rows = extraIds.length ? [...base, ...(await this.db.select().from(knowledgeRecords).where(inArray(knowledgeRecords.id, extraIds)))] : base;

    const scopeTasks = viewer.kind === "agent" ? await this.relatedTasks(viewer.taskId) : null;
    const depTasks = q.taskId ?? (viewer.kind === "agent" ? viewer.taskId : undefined);
    const upstream = depTasks ? await this.upstreamTasks(depTasks) : new Set<string>();
    const visible = rows.filter((r) => r.scope !== "task" || !scopeTasks || (r.sourceTaskId && scopeTasks.has(r.sourceTaskId)));

    const maxFts = Math.max(0.0001, ...fts.values());
    const now = Date.now();
    const prelim = visible.map((r) => {
      const ftsScore = (fts.get(r.id) ?? 0) / maxFts;
      const semantic = qvec && r.embedding ? Math.max(0, cosine(qvec, r.embedding)) : 0;
      const path = q.paths.length && r.affectedPaths.length && pathsOverlap(r.affectedPaths, q.paths) ? 1 : 0;
      const dependency = r.sourceTaskId && upstream.has(r.sourceTaskId) ? 1 : 0;
      const trust = TRUST[r.status];
      const ageDays = (now - r.updatedAt.getTime()) / 86_400_000;
      const recency = Math.pow(0.5, ageDays / 14);
      return { r, signals: { fts: ftsScore, semantic, path, dependency, relation: 0, trust, recency } };
    });
    // Without a query, everything matching filters is a candidate; with a query, require some relevance signal.
    const relevant = (s: (typeof prelim)[number]["signals"]) => !query && !q.paths.length ? true : s.fts > 0 || s.semantic >= 0.2 || s.path > 0 || s.dependency > 0;
    const seeds = prelim.filter((p) => relevant(p.signals));
    // Relationship traversal: one hop from seeds.
    if (seeds.length) {
      const seedIds = seeds.map((s) => s.r.id);
      const rels = await this.db.select().from(knowledgeRelations).where(or(inArray(knowledgeRelations.fromId, seedIds), inArray(knowledgeRelations.toId, seedIds)));
      const neighbours = new Set(rels.flatMap((x) => [x.fromId, x.toId]));
      for (const p of prelim) if (neighbours.has(p.r.id)) p.signals.relation = 1;
    }
    const scored = prelim
      .filter((p) => relevant(p.signals) || p.signals.relation > 0)
      .map((p) => {
        const s = p.signals;
        const relevance = 0.35 * s.fts + 0.25 * s.semantic + 0.15 * s.path + 0.15 * s.dependency + 0.1 * s.relation;
        const score = (query || q.paths.length ? relevance : 0.5) * (0.5 + 0.5 * s.trust) * (0.8 + 0.2 * s.recency);
        return { ...p, score };
      })
      .sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id))
      .slice(0, q.limit);
    if (opts.recordAs && viewer.kind === "agent") await this.recordConsumption(scored.map((s) => s.r), viewer, opts.recordAs, opts.snapshotId);
    return Promise.all(
      scored.map(async (s) => ({ record: await this.toRecord(s.r), score: Number(s.score.toFixed(4)), signals: roundSignals(s.signals), authoritative: AUTHORITATIVE_STATUSES.includes(s.r.status) })),
    );
  }

  /**
   * Knowledge selected for a task's context pack. Authoritative and provisional records are
   * separated so the compiler can label them; excluded statuses never appear.
   */
  async forContext(task: { id: string; projectId: string; title: string; description: string; allowedPaths: string[] }, agentId: string, extraPaths: string[]) {
    const viewer: Viewer = { kind: "agent", actor: `agent:${agentId}`, agentId, projectId: task.projectId, taskId: task.id, runId: null };
    const q = { query: `${task.title} ${task.description}`.slice(0, 1000), types: [], paths: [...new Set([...task.allowedPaths.filter((p) => p !== "**"), ...extraPaths])], taskId: task.id, limit: 25 };
    const hits = await this.search(task.projectId, q, viewer);
    // Accepted decisions and contracts apply project-wide even without lexical overlap.
    const decisions = await this.db
      .select()
      .from(knowledgeRecords)
      .where(and(eq(knowledgeRecords.projectId, task.projectId), inArray(knowledgeRecords.type, ["architectural_decision", "api_contract"]), inArray(knowledgeRecords.status, ["accepted", "verified"])))
      .orderBy(desc(knowledgeRecords.updatedAt))
      .limit(20);
    const decisionRecords = (await Promise.all(decisions.filter((d) => d.allowedAgentIds === null || d.allowedAgentIds.includes(agentId)).map((d) => this.toRecord(d)))).filter((d) => d.status === "accepted" || d.type === "api_contract");
    const seen = new Set(decisionRecords.map((d) => d.id));
    return {
      decisions: decisionRecords,
      verified: hits.filter((h) => h.authoritative && !seen.has(h.record.id)).map((h) => h.record),
      provisional: hits.filter((h) => PROVISIONAL_STATUSES.includes(h.record.status)).map((h) => h.record),
    };
  }

  async recordConsumption(rows: { id: string; version: number }[], viewer: Extract<Viewer, { kind: "agent" }>, via: "context" | "search" | "get" | "refresh", snapshotId?: string) {
    if (!rows.length) return;
    await this.db.insert(knowledgeConsumption).values(
      rows.map((r) => ({ knowledgeId: r.id, knowledgeVersion: r.version, taskId: viewer.taskId, runId: viewer.runId, agentId: viewer.agentId, contextSnapshotId: snapshotId ?? null, via })),
    );
  }

  /** Records changed since `since` that are visible to the viewer, plus subscription notifications. */
  async changesSince(viewer: Extract<Viewer, { kind: "agent" }>, since: Date) {
    const rows = await this.db
      .select()
      .from(knowledgeRecords)
      .where(and(eq(knowledgeRecords.projectId, viewer.projectId), gt(knowledgeRecords.updatedAt, since)))
      .orderBy(knowledgeRecords.updatedAt)
      .limit(100);
    const visible = [];
    for (const r of rows) if (await this.visible(r, viewer)) visible.push(r);
    const notes = await this.db
      .select()
      .from(events)
      .where(and(eq(events.taskId, viewer.taskId), eq(events.type, "knowledge.notify"), gt(events.createdAt, since)))
      .orderBy(events.id)
      .limit(100);
    await this.recordConsumption(visible.filter((r) => !EXCLUDED_STATUSES.includes(r.status)), viewer, "refresh");
    return {
      changed: await Promise.all(visible.map(async (r) => ({ record: await this.toRecord(r), authoritative: AUTHORITATIVE_STATUSES.includes(r.status) }))),
      notifications: notes.map((n) => n.payload),
      asOf: new Date().toISOString(),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Status changes. Rules (ADR-008):
   * - Only humans accept, reject or request revalidation.
   * - Agents may verify/dispute only records published by a *different* agent, with evidence;
   *   architectural decisions can only become authoritative through human acceptance.
   * - Stale records must be revalidated (back to proposed) before they can be verified/accepted.
   */
  async act(id: string, action: KnowledgeAction, viewer: Viewer): Promise<KnowledgeRecord> {
    const out = await this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(knowledgeRecords).where(eq(knowledgeRecords.id, id)).for("update");
      if (!row || !(await this.visible(row, viewer, tx))) throw notFound("Knowledge record", id);
      const human = viewer.kind === "user";
      if (human && viewer.role === "viewer") throw forbidden("Requires operator role");
      let next: KnowledgeStatus = row.status;
      const patch: Partial<typeof knowledgeRecords.$inferInsert> = {};
      const reason = "comment" in action ? action.comment : "";
      switch (action.action) {
        case "add_evidence":
          await this.addEvidence(tx, id, action.evidence, viewer.actor, null);
          if (row.status === "proposed" && action.evidence.some((e) => VERIFIABLE_EVIDENCE.has(e.kind))) next = "evidenced";
          break;
        case "verify": {
          if (!["proposed", "evidenced", "disputed"].includes(row.status)) throw new DomainError("INVALID_KNOWLEDGE_TRANSITION", `Cannot verify a ${row.status} record${row.status === "stale" ? "; revalidate it first" : ""}`, 409);
          if (viewer.kind === "agent") {
            if (row.sourceAgentId === viewer.agentId) throw forbidden("An agent cannot verify its own finding");
            if (row.type === "architectural_decision") throw forbidden("Architectural decisions require human acceptance");
            if (!("evidence" in action) || !action.evidence.length) throw new DomainError("EVIDENCE_REQUIRED", "Verification requires evidence", 422);
          }
          await this.addEvidence(tx, id, action.evidence, viewer.actor, null);
          next = "verified";
          Object.assign(patch, { verifiedBy: viewer.actor, verifiedAt: new Date() });
          break;
        }
        case "accept":
          if (!human) throw forbidden("Only humans can accept knowledge as authoritative");
          if (["stale", "rejected", "superseded"].includes(row.status)) throw new DomainError("INVALID_KNOWLEDGE_TRANSITION", `Cannot accept a ${row.status} record${row.status === "stale" ? "; revalidate it first" : ""}`, 409);
          next = "accepted";
          Object.assign(patch, { verifiedBy: row.verifiedBy ?? viewer.actor, verifiedAt: row.verifiedAt ?? new Date() });
          break;
        case "dispute":
          if (["rejected", "superseded"].includes(row.status)) throw new DomainError("INVALID_KNOWLEDGE_TRANSITION", `Cannot dispute a ${row.status} record`, 409);
          next = "disputed";
          break;
        case "reject":
          if (!human) throw forbidden("Only humans can reject knowledge");
          next = "rejected";
          break;
        case "revalidate":
          if (!human) throw forbidden("Only humans can request revalidation");
          next = "proposed";
          Object.assign(patch, { verifiedBy: null, verifiedAt: null });
          break;
      }
      const [u] = await tx
        .update(knowledgeRecords)
        .set({ ...patch, status: next, statusReason: reason || row.statusReason, version: sql`${knowledgeRecords.version} + 1`, updatedAt: new Date() })
        .where(eq(knowledgeRecords.id, id))
        .returning();
      // A verified/accepted record that supersedes others retires them.
      if ((next === "verified" || next === "accepted") && row.status !== next) {
        const sup = await tx.select().from(knowledgeRelations).where(and(eq(knowledgeRelations.fromId, id), eq(knowledgeRelations.relation, "supersedes")));
        for (const s of sup) {
          await tx.update(knowledgeRecords).set({ status: "superseded", supersededById: id, statusReason: `superseded by ${id}`, version: sql`${knowledgeRecords.version} + 1`, updatedAt: new Date() }).where(eq(knowledgeRecords.id, s.toId));
        }
      }
      await this.log(tx, u!, `knowledge.${action.action}`, viewer.actor, { from: row.status, to: next, comment: reason });
      return u!;
    });
    await this.notifySubscribers(out);
    return this.toRecord(out);
  }

  /**
   * Called after code is integrated. Records about files that changed (in a commit not
   * produced by the record's own source task) become stale and drop out of context packs
   * until a human requests revalidation and they are verified again.
   */
  async markStaleForChanges(projectId: string, changedPaths: string[], cause: { taskId: string; mergeSha: string }): Promise<string[]> {
    if (!changedPaths.length) return [];
    const candidates = await this.db
      .select()
      .from(knowledgeRecords)
      .where(and(eq(knowledgeRecords.projectId, projectId), inArray(knowledgeRecords.status, ["proposed", "evidenced", "verified", "accepted"])));
    const stale: string[] = [];
    for (const r of candidates) {
      if (!r.affectedPaths.length || r.sourceTaskId === cause.taskId) continue;
      if (!pathsOverlap(r.affectedPaths, changedPaths)) continue;
      const reason = `affected paths changed by task ${cause.taskId} (merge ${cause.mergeSha.slice(0, 12)})`;
      const [u] = await this.db
        .update(knowledgeRecords)
        .set({ status: "stale", statusReason: reason, version: sql`${knowledgeRecords.version} + 1`, updatedAt: new Date() })
        .where(and(eq(knowledgeRecords.id, r.id), eq(knowledgeRecords.status, r.status)))
        .returning();
      if (u) {
        stale.push(u.id);
        await this.log(this.db, u, "knowledge.stale", "engine", { from: r.status, reason, changedPaths: changedPaths.slice(0, 50) });
      }
    }
    return stale;
  }

  async conflicts(projectId: string) {
    const rows = await this.db
      .select({ rel: knowledgeRelations })
      .from(knowledgeRelations)
      .innerJoin(knowledgeRecords, eq(knowledgeRecords.id, knowledgeRelations.fromId))
      .where(and(eq(knowledgeRecords.projectId, projectId), eq(knowledgeRelations.relation, "contradicts")));
    const disputed = await this.db.select().from(knowledgeRecords).where(and(eq(knowledgeRecords.projectId, projectId), eq(knowledgeRecords.status, "disputed")));
    const ids = [...new Set(rows.flatMap((r) => [r.rel.fromId, r.rel.toId]))];
    const recs = ids.length ? await this.db.select().from(knowledgeRecords).where(inArray(knowledgeRecords.id, ids)) : [];
    const byId = new Map(await Promise.all(recs.map(async (r) => [r.id, await this.toRecord(r)] as const)));
    return {
      contradictions: rows.map((r) => ({ from: byId.get(r.rel.fromId), to: byId.get(r.rel.toId), createdBy: r.rel.createdBy })),
      disputed: await Promise.all(disputed.map((d) => this.toRecord(d))),
    };
  }

  // ------------------------------------------------------------------ subscriptions

  async subscribe(input: { projectId: string; taskId: string; types: string[]; paths: string[]; query: string }, actor: string) {
    const [s] = await this.db.insert(knowledgeSubscriptions).values({ ...input, createdBy: actor }).returning();
    return { ...s!, createdAt: s!.createdAt.toISOString() };
  }

  private async notifySubscribers(row: Row): Promise<void> {
    const subs = await this.db.select().from(knowledgeSubscriptions).where(eq(knowledgeSubscriptions.projectId, row.projectId));
    if (!subs.length) return;
    const text = new Set(tokenize(`${row.title} ${row.statement}`));
    const active = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, subs.map((s) => s.taskId)));
    const activeIds = new Set(active.map((a) => a.id));
    for (const s of subs) {
      if (!activeIds.has(s.taskId) || s.taskId === row.sourceTaskId) continue;
      if (s.types.length && !s.types.includes(row.type)) continue;
      if (s.paths.length && !pathsOverlap(s.paths, row.affectedPaths)) continue;
      if (s.query && !tokenize(s.query).some((t) => text.has(t))) continue;
      await this.db.insert(events).values({
        projectId: row.projectId,
        taskId: s.taskId,
        type: "knowledge.notify",
        payload: { knowledgeId: row.id, title: row.title, status: row.status, version: row.version, subscriptionId: s.id },
      });
    }
  }

  // ------------------------------------------------------------------ authorization helpers

  private assertProject(viewer: Viewer, projectId: string) {
    if (viewer.kind === "agent" && viewer.projectId !== projectId) throw forbidden("Agent session is not scoped to this project");
    if (viewer.kind === "user" && viewer.projectIds && !viewer.projectIds.includes(projectId)) throw forbidden("Token is not authorized for this project");
  }

  private async visible(row: Row, viewer: Viewer, db: DbOrTx = this.db): Promise<boolean> {
    if (viewer.kind === "user") return !viewer.projectIds || viewer.projectIds.includes(row.projectId);
    if (row.projectId !== viewer.projectId) return false;
    if (row.allowedAgentIds && !row.allowedAgentIds.includes(viewer.agentId)) return false;
    if (row.scope === "task") {
      const related = await this.relatedTasks(viewer.taskId, db);
      return !!row.sourceTaskId && related.has(row.sourceTaskId);
    }
    return true;
  }

  /** The task, its ancestors (parent/requester) and its upstream dependencies. */
  private async relatedTasks(taskId: string, db: DbOrTx = this.db): Promise<Set<string>> {
    const out = new Set<string>([taskId]);
    let frontier = [taskId];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const rows = await db.select({ id: tasks.id, parent: tasks.parentTaskId, requester: tasks.requestedByTaskId }).from(tasks).where(inArray(tasks.id, frontier));
      const deps = await db.select({ d: taskDependencies.dependsOnTaskId }).from(taskDependencies).where(inArray(taskDependencies.taskId, frontier));
      const next = [...rows.flatMap((r) => [r.parent, r.requester]), ...deps.map((d) => d.d)].filter((x): x is string => !!x && !out.has(x));
      next.forEach((n) => out.add(n));
      frontier = next;
    }
    return out;
  }

  private async upstreamTasks(taskId: string): Promise<Set<string>> {
    const s = await this.relatedTasks(taskId);
    s.delete(taskId);
    return s;
  }

  private async log(db: DbOrTx, row: Row, type: string, actor: string, detail: Record<string, unknown>) {
    await db.insert(events).values({ projectId: row.projectId, taskId: row.sourceTaskId, type, payload: { knowledgeId: row.id, version: row.version, actor, ...detail } });
    await db.insert(auditLog).values({ actor, action: type, targetType: "knowledge", targetId: row.id, detail: defaultRedactor.redactDeep(detail) });
  }

  async toRecord(r: Row): Promise<KnowledgeRecord> {
    const ev = await this.db.select({ id: knowledgeEvidence.id }).from(knowledgeEvidence).where(eq(knowledgeEvidence.knowledgeId, r.id));
    return {
      id: r.id,
      projectId: r.projectId,
      repositoryId: r.repositoryId,
      type: r.type,
      title: r.title,
      statement: r.statement,
      status: r.status,
      scope: r.scope,
      allowedAgentIds: r.allowedAgentIds,
      confidence: r.confidence,
      tags: r.tags,
      sourceAgentId: r.sourceAgentId,
      sourceRunId: r.sourceRunId,
      sourceTaskId: r.sourceTaskId,
      sourceActor: r.sourceActor,
      sourceCommitSha: r.sourceCommitSha,
      evidenceIds: ev.map((e) => e.id),
      affectedPaths: r.affectedPaths,
      supersededById: r.supersededById,
      verifiedBy: r.verifiedBy,
      verifiedAt: iso(r.verifiedAt),
      statusReason: r.statusReason,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

export function fingerprintOf(type: string, statement: string): string {
  const norm = tokenize(statement).join(" ");
  return createHash("sha256").update(`${type}\n${norm}`).digest("hex");
}

function roundSignals(s: SearchHit["signals"]): SearchHit["signals"] {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v.toFixed(3))])) as SearchHit["signals"];
}
