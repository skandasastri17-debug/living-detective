/** Shared display metadata for evidence kinds — used by the Evidence panel and the cinematic reveal modals. */

import type { EvidenceKind } from "../investigation/casefile";

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  "scene-report": "Scene",
  "autopsy": "Autopsy",
  "footprint": "Footprint",
  "fingerprint": "Prints",
  "dna": "DNA",
  "weapon": "Weapon",
  "item": "Item",
  "camera-log": "Camera",
  "phone-records": "Phone",
  "financial-records": "Financial",
  "testimony": "Testimony",
  "document": "Document",
};

export const EVIDENCE_KIND_TAGS: Partial<Record<EvidenceKind, "accent" | "danger" | "info" | "success">> = {
  "weapon": "danger",
  "autopsy": "danger",
  "dna": "danger",
  "fingerprint": "accent",
  "footprint": "accent",
  "camera-log": "info",
  "testimony": "info",
};
