/** Name pools for NPC and place generation. */

export const FIRST_M = [
  "Arthur", "Bennett", "Caleb", "Dominic", "Elias", "Felix", "Gideon", "Harold",
  "Isaac", "Julian", "Kenji", "Leonard", "Marcus", "Nathaniel", "Oscar", "Preston",
  "Quentin", "Raymond", "Silas", "Theodore", "Victor", "Wesley", "Xavier", "Yusuf",
  "Andre", "Boris", "Cornelius", "Desmond", "Emmett", "Franklin", "Grady", "Hugo",
  "Ivan", "Jasper", "Kofi", "Lionel", "Mateo", "Nico", "Otis", "Percy",
] as const;

export const FIRST_F = [
  "Adeline", "Beatrice", "Celia", "Daphne", "Eleanor", "Frances", "Greta", "Harriet",
  "Ingrid", "Josephine", "Katya", "Lucille", "Miriam", "Nadia", "Opal", "Penelope",
  "Quinn", "Rosalind", "Sylvia", "Tabitha", "Ursula", "Vera", "Willa", "Xenia",
  "Amara", "Bianca", "Colette", "Delia", "Esme", "Flora", "Gwen", "Helena",
  "Iris", "Juno", "Kira", "Leona", "Mabel", "Noor", "Odette", "Priya",
] as const;

export const LAST = [
  "Ashford", "Blackwood", "Calloway", "Draper", "Ellsworth", "Fairbanks", "Grimshaw",
  "Hollis", "Ivers", "Jennings", "Kowalski", "Lockhart", "Merriweather", "Nakamura",
  "Okafor", "Pemberton", "Quill", "Rutherford", "Sinclair", "Thorne", "Underhill",
  "Vasquez", "Whitlock", "Yardley", "Zhou", "Abernathy", "Birch", "Crane", "Dunmore",
  "Eastwood", "Falk", "Garrick", "Hale", "Ibarra", "Juneau", "Kessler", "Larkin",
  "Moreau", "Novak", "Osei", "Pryce", "Rooke", "Sato", "Trask", "Voss", "Winslow",
] as const;

export const STREET_NAMES = [
  "Elm", "Ash", "Birch", "Cedar", "Maple", "Willow", "Juniper", "Rowan",
  "Harbor", "Foundry", "Mercer", "Aldgate", "Crown", "Ludlow", "Pinch", "Verge",
  "Cannery", "Signal", "Meridian", "Larch", "Quay", "Tanner", "Cooper", "Mason",
] as const;

export const CITY_PREFIX = ["Port", "New", "East", "West", "North", "Lower", "Old", "Fort"] as const;
export const CITY_CORE = [
  "Halden", "Merrow", "Vane", "Corvid", "Ashby", "Dunmore", "Larkspur", "Greywick",
  "Bellham", "Marrow", "Cinder", "Rooksey", "Tallow", "Wrenfield", "Ostmere", "Kelder",
] as const;

export const BAR_NAMES = ["The Rusty Anchor", "The Crooked Lamp", "The Tin Whistle", "The Last Call", "The Hollow Barrel", "The Night Heron"] as const;
export const CAFE_NAMES = ["Meridian Coffee", "The Percolator", "Grind House", "Little Crow Café", "Ember & Oak"] as const;
export const RESTAURANT_NAMES = ["The Copper Kettle", "Marrow & Bone", "Salt Line Diner", "The Blue Plate", "Fig & Farrow"] as const;
export const STORE_NAMES = ["Corner Goods", "Hollis General", "Northgate Market", "The Pantry", "Quay Street Grocer"] as const;
export const OFFICE_NAMES = ["Meridian Insurance", "Vane & Partners", "Cardinal Logistics", "Bellham Trust", "Greywick Media"] as const;
export const FACTORY_NAMES = ["Ironline Works", "Cannery Row Plant", "Foundry No. 3", "Tallow Fabrication"] as const;
export const WAREHOUSE_NAMES = ["Dockside Storage", "Unit 9 Depot", "Kelder Freight"] as const;
export const PARK_NAMES = ["Dover Park", "Wren Green", "Signal Hill Park", "Old Cannery Commons"] as const;
