import type { Filter } from "mongodb";
import { isDumpedCoin } from "./dumpCheck";
import type { CoinDoc } from "./types";

export { isDumpedCoin };

export function notDumpedMongo(): Filter<CoinDoc> {
  return {
    $nor: [
      { status: "exit" },
      { exitProb: { $gte: 0.75 } },
      { change5m: { $lte: -35 } },
      { change1h: { $lte: -50 } },
      { change6h: { $lte: -50 } },
      { minRatio: { $lt: 0.45 } },
    ],
  };
}
