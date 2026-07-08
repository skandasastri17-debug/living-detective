/**
 * The case file: everything the player has learned.
 *
 * The world knows the whole truth; the UI may only show what's in here.
 * Evidence entries and statements are projections of world truth collected
 * through investigative actions. Contradiction detection compares statements
 * against *collected* evidence only — the detective can't use facts the
 * player hasn't found.
 */

import type { SimTime } from "../core/time";
import { fmtTime } from "../core/time";
import type { BuildingId, ItemId, NpcId, Secret, World } from "../world/types";

export type EvidenceKind =
  | "scene-report"
  | "autopsy"
  | "footprint"
  | "fingerprint"
  | "dna"
  | "weapon"
  | "item"
  | "camera-log"
  | "phone-records"
  | "financial-records"
  | "testimony"
  | "document";

export interface EvidenceEntry {
  id: string;
  kind: EvidenceKind;
  title: string;
  detail: string;
  discoveredAt: SimTime;
  buildingId: BuildingId | null;
  itemId: ItemId | null;
  /** People this evidence concerns/implicates. */
  npcIds: NpcId[];
  /**
   * Machine-readable placement: this evidence places `npcIds` at
   * `placesAtBuildingId` during [placesFrom, placesTo]. Used for
   * contradiction detection.
   */
  placesAtBuildingId: BuildingId | null;
  placesFrom: SimTime | null;
  placesTo: SimTime | null;
  /**
   * Negative placement: this evidence establishes `npcIds` were NOT at this
   * building during [placesFrom, placesTo] (e.g. staff who never saw them
   * come in). Verified against the event log at creation — never a guess.
   */
  absentFromBuildingId?: BuildingId | null;
  /** Objective flag: this evidence documents a motive-grade fact (debt, affair, blackmail…). */
  motiveHint?: boolean;
  /** Objective flag: this evidence physically ties someone to a specific item. */
  itemLink?: boolean;
  /** Objective flag: post-crime conduct that betrays guilt (tampering, intimidation). */
  consciousnessOfGuilt?: boolean;
}

export type QuestionTopic =
  | "whereabouts"
  | "last-saw-victim"
  | "relationship-victim"
  | "anything-unusual"
  | "about-person"
  | "enemies"
  | "confront";

export interface Claim {
  /** Who this claim places (usually the speaker, sometimes someone else). */
  npcId: NpcId;
  from: SimTime;
  to: SimTime;
  buildingId: BuildingId | null; // null = "can't say"
  description: string;
}

export interface Statement {
  id: string;
  npcId: NpcId; // the speaker
  t: SimTime;
  topic: QuestionTopic;
  aboutNpcId: NpcId | null;
  question: string;
  answer: string;
  claims: Claim[];
  /** Speaker was holding back (reluctant/hostile witness). */
  guarded?: boolean;
}

export interface Contradiction {
  statementId: string;
  claimIndex: number;
  evidenceId: string;
  npcId: NpcId;
  summary: string;
}

export type RelationFactKind =
  | "feud" // documented hostility
  | "affair"
  | "debt"
  | "blackmail"
  | "romance" // admitted/observed attraction outside public marriage
  | "theft-victim"; // a stole from b

/**
 * A relationship fact the detective has LEARNED — minted only when a piece
 * of evidence or testimony reveals it. Public facts (marriages, households,
 * workplaces) are not stored; they are derivable town knowledge.
 */
export interface RelationFact {
  aId: NpcId;
  bId: NpcId;
  kind: RelationFactKind;
  sourceEvidenceId: string;
  label: string;
}

export interface AccusationResult {
  accusedId: NpcId;
  motiveGuess: string;
  correct: boolean;
  caseStrength: number; // 0-100
  breakdown: string[];
  verdict: "conviction" | "walks-free" | "wrongful";
  revealText: string[];
}

export interface CaseFile {
  openedAt: SimTime;
  detectiveAt: BuildingId; // player position
  victimId: NpcId;
  evidence: EvidenceEntry[];
  statements: Statement[];
  interviewed: NpcId[];
  searchedBuildings: BuildingId[];
  phoneRecordsPulled: NpcId[];
  financialRecordsPulled: NpcId[];
  cameraLogsPulled: BuildingId[];
  autopsyDone: boolean;
  warrants: BuildingId[];
  /** NPCs who have cracked under a confrontation already (won't crack twice). */
  crackedOnce: NpcId[];
  /** Reluctant/hostile witnesses who have been opened up with leverage. */
  openedUp: NpcId[];
  notes: string[];
  /** Relationship facts revealed by evidence/testimony (graph panel). */
  relationFacts: RelationFact[];
  accusation: AccusationResult | null;
  nextEvidenceId: number;
  nextStatementId: number;
}

export function newCaseFile(world: World, victimId: NpcId, detectiveStartId: BuildingId): CaseFile {
  return {
    openedAt: world.time,
    detectiveAt: detectiveStartId,
    victimId,
    evidence: [],
    statements: [],
    interviewed: [],
    searchedBuildings: [],
    phoneRecordsPulled: [],
    financialRecordsPulled: [],
    cameraLogsPulled: [],
    autopsyDone: false,
    warrants: [],
    crackedOnce: [],
    openedUp: [],
    notes: [],
    relationFacts: [],
    accusation: null,
    nextEvidenceId: 0,
    nextStatementId: 0,
  };
}

/** Record a learned relationship fact (deduplicated per pair+kind). */
export function addRelationFact(
  cf: CaseFile,
  aId: NpcId,
  bId: NpcId,
  kind: RelationFactKind,
  sourceEvidenceId: string,
  label: string
): void {
  const exists = cf.relationFacts.some(
    (f) =>
      f.kind === kind &&
      ((f.aId === aId && f.bId === bId) || (f.aId === bId && f.bId === aId))
  );
  if (!exists) cf.relationFacts.push({ aId, bId, kind, sourceEvidenceId, label });
}

/** Learn the relationship edge implied by a revealed secret, if any. */
export function learnFactFromSecret(cf: CaseFile, secret: Secret, sourceEvidenceId: string): void {
  if (!secret.otherId) return; // single-person secrets carry no edge
  const map: Partial<Record<Secret["kind"], RelationFactKind>> = {
    "affair": "affair",
    "heavy-debt": "debt",
    "blackmail": "blackmail",
    "being-blackmailed": "blackmail",
    "theft": "theft-victim",
  };
  const kind = map[secret.kind];
  if (!kind) return;
  addRelationFact(cf, secret.holderId, secret.otherId, kind, sourceEvidenceId, secret.description);
}

export function addEvidence(cf: CaseFile, e: Omit<EvidenceEntry, "id">): EvidenceEntry {
  // De-duplicate identical finds (same kind + title).
  const existing = cf.evidence.find((x) => x.kind === e.kind && x.title === e.title);
  if (existing) return existing;
  const entry: EvidenceEntry = { ...e, id: `evd:${cf.nextEvidenceId++}` };
  cf.evidence.push(entry);
  return entry;
}

export function addStatement(cf: CaseFile, s: Omit<Statement, "id">): Statement {
  const st: Statement = { ...s, id: `stm:${cf.nextStatementId++}` };
  cf.statements.push(st);
  return st;
}

/**
 * Cross-reference every claim against every piece of collected evidence.
 * A contradiction = evidence placing the same person somewhere else during
 * an overlapping window, OR evidence establishing they were absent from the
 * very place they claim to have been.
 */
export function computeContradictions(cf: CaseFile): Contradiction[] {
  const out: Contradiction[] = [];
  for (const st of cf.statements) {
    st.claims.forEach((claim, ci) => {
      if (!claim.buildingId) return;
      for (const ev of cf.evidence) {
        if (ev.placesFrom === null || ev.placesTo === null) continue;
        if (!ev.npcIds.includes(claim.npcId)) continue;
        const overlap = Math.min(claim.to, ev.placesTo) - Math.max(claim.from, ev.placesFrom);
        if (overlap <= 0) continue;
        // Positive placement somewhere else.
        if (ev.placesAtBuildingId && ev.placesAtBuildingId !== claim.buildingId) {
          out.push({
            statementId: st.id,
            claimIndex: ci,
            evidenceId: ev.id,
            npcId: claim.npcId,
            summary: `Statement says ${claim.description}, but "${ev.title}" places them elsewhere around ${fmtTime(Math.max(claim.from, ev.placesFrom))}.`,
          });
        }
        // Negative placement at the claimed spot.
        if (ev.absentFromBuildingId && ev.absentFromBuildingId === claim.buildingId) {
          out.push({
            statementId: st.id,
            claimIndex: ci,
            evidenceId: ev.id,
            npcId: claim.npcId,
            summary: `Statement says ${claim.description}, but "${ev.title}" establishes they were never there around ${fmtTime(Math.max(claim.from, ev.placesFrom))}.`,
          });
        }
      }
    });
  }
  return out;
}

/** Evidence gathered about a specific person (for suspect view). */
export function evidenceAbout(cf: CaseFile, npcId: NpcId): EvidenceEntry[] {
  return cf.evidence.filter((e) => e.npcIds.includes(npcId));
}
