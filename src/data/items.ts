/** Item catalog: what things exist, where they naturally occur, lethality. */

import type { BuildingType, ItemKind } from "../world/types";

export interface ItemDef {
  kind: ItemKind;
  label: string;
  lethality: number; // 0..1
  /** Room-name keywords this item naturally appears in. */
  roomAffinity: string[];
  /** Building types where it can be found even without a matching room. */
  buildingAffinity: BuildingType[];
  /** Available for purchase in stores. */
  purchasable: boolean;
  price: number;
}

export const ITEM_DEFS: ItemDef[] = [
  { kind: "kitchen-knife", label: "Kitchen knife", lethality: 0.9, roomAffinity: ["Kitchen"], buildingAffinity: ["restaurant"], purchasable: true, price: 25 },
  { kind: "hunting-knife", label: "Hunting knife", lethality: 0.95, roomAffinity: [], buildingAffinity: ["store"], purchasable: true, price: 60 },
  { kind: "wrench", label: "Pipe wrench", lethality: 0.7, roomAffinity: ["Workshop", "Garage", "Floor"], buildingAffinity: ["factory", "warehouse"], purchasable: true, price: 30 },
  { kind: "hammer", label: "Claw hammer", lethality: 0.75, roomAffinity: ["Workshop", "Garage"], buildingAffinity: ["factory", "warehouse", "store"], purchasable: true, price: 20 },
  { kind: "crowbar", label: "Crowbar", lethality: 0.75, roomAffinity: ["Storage", "Loading"], buildingAffinity: ["warehouse", "factory"], purchasable: true, price: 28 },
  { kind: "bat", label: "Baseball bat", lethality: 0.7, roomAffinity: ["Bedroom", "Living"], buildingAffinity: ["store"], purchasable: true, price: 35 },
  { kind: "scissors", label: "Scissors", lethality: 0.5, roomAffinity: ["Office", "Study", "Kitchen"], buildingAffinity: ["office", "school"], purchasable: true, price: 8 },
  { kind: "letter-opener", label: "Letter opener", lethality: 0.55, roomAffinity: ["Office", "Study"], buildingAffinity: ["office"], purchasable: false, price: 15 },
  { kind: "trophy", label: "Brass trophy", lethality: 0.6, roomAffinity: ["Living", "Office"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "rope", label: "Coil of rope", lethality: 0.65, roomAffinity: ["Storage", "Garage", "Loading"], buildingAffinity: ["warehouse", "store"], purchasable: true, price: 12 },
  { kind: "bottle", label: "Glass bottle", lethality: 0.45, roomAffinity: ["Bar floor", "Kitchen", "Cellar"], buildingAffinity: ["bar", "restaurant", "store"], purchasable: true, price: 9 },
  { kind: "wallet", label: "Wallet", lethality: 0, roomAffinity: ["Bedroom", "Living"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "phone", label: "Mobile phone", lethality: 0, roomAffinity: ["Bedroom"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "keys", label: "Key ring", lethality: 0, roomAffinity: ["Hallway", "Living"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "watch", label: "Wristwatch", lethality: 0, roomAffinity: ["Bedroom"], buildingAffinity: [], purchasable: true, price: 80 },
  { kind: "necklace", label: "Silver necklace", lethality: 0, roomAffinity: ["Bedroom"], buildingAffinity: [], purchasable: true, price: 120 },
  { kind: "cash-box", label: "Cash box", lethality: 0, roomAffinity: ["Office", "Back room"], buildingAffinity: ["store", "bar", "restaurant"], purchasable: false, price: 0 },
  { kind: "ledger", label: "Accounts ledger", lethality: 0, roomAffinity: ["Office", "Study", "Back room"], buildingAffinity: ["office", "store"], purchasable: false, price: 0 },
  { kind: "photo", label: "Framed photo", lethality: 0, roomAffinity: ["Living", "Bedroom"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "letter", label: "Letter", lethality: 0, roomAffinity: ["Study", "Bedroom", "Living"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "note", label: "Handwritten note", lethality: 0, roomAffinity: ["Kitchen", "Office"], buildingAffinity: [], purchasable: false, price: 0 },
  { kind: "book", label: "Book", lethality: 0, roomAffinity: ["Study", "Living", "Bedroom"], buildingAffinity: ["school"], purchasable: true, price: 14 },
  { kind: "glass", label: "Drinking glass", lethality: 0.1, roomAffinity: ["Kitchen", "Bar floor"], buildingAffinity: ["bar", "restaurant", "cafe"], purchasable: false, price: 0 },
  { kind: "coat", label: "Overcoat", lethality: 0, roomAffinity: ["Hallway", "Bedroom"], buildingAffinity: [], purchasable: true, price: 90 },
  { kind: "umbrella", label: "Umbrella", lethality: 0.2, roomAffinity: ["Hallway"], buildingAffinity: ["office"], purchasable: true, price: 18 },
  { kind: "toolbox", label: "Toolbox", lethality: 0.3, roomAffinity: ["Garage", "Workshop", "Storage"], buildingAffinity: ["factory", "warehouse"], purchasable: true, price: 45 },
  { kind: "first-aid-kit", label: "First aid kit", lethality: 0, roomAffinity: ["Kitchen", "Ward"], buildingAffinity: ["hospital", "factory", "school"], purchasable: true, price: 22 },
  { kind: "register", label: "Cash register", lethality: 0, roomAffinity: ["Front", "Bar floor", "Counter"], buildingAffinity: ["store", "cafe", "restaurant", "bar"], purchasable: false, price: 0 },
];

export function itemDef(kind: ItemKind): ItemDef {
  const d = ITEM_DEFS.find((x) => x.kind === kind);
  if (!d) throw new Error(`Unknown item kind ${kind}`);
  return d;
}

export const WEAPON_KINDS = ITEM_DEFS.filter((d) => d.lethality >= 0.45).map((d) => d.kind);
