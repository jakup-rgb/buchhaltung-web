import type { Category } from "./classify";

export function classifyByHeuristic(hint: string): Category {
  const s = hint.toLowerCase();

  const kfz = ["shell", "aral", "omv", "esso", "jet", "reifen", "werkstatt", "tanke", "benzin", "diesel"];
  const markt = ["rewe", "aldi", "lidl", "penny", "edeka", "spar", "dm", "rossmann", "kaufland"];
  const buero = ["amazon", "mediamarkt", "saturn", "druck", "papier", "office", "software", "lizenz"];
  const resto = ["restaurant", "cafe", "bistro", "pizza", "döner", "lieferando", "mcdonald", "burger"];

  if (kfz.some((x) => s.includes(x))) return "KFZ";
  if (markt.some((x) => s.includes(x))) return "MARKT";
  if (buero.some((x) => s.includes(x))) return "BUERO";
  if (resto.some((x) => s.includes(x))) return "RESTAURANT";
  return "SONSTIGES";
}
