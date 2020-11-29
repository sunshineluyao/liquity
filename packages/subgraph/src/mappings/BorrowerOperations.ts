import { TroveManager } from "../../generated/TroveManager/TroveManager";
import {
  BorrowerOperations,
  CDPUpdated
} from "../../generated/templates/BorrowerOperations/BorrowerOperations";

import { getTroveOperationFromBorrowerOperation } from "../types/TroveOperation";

import { updateTrove } from "../entities/Trove";

export function handleCDPUpdated(event: CDPUpdated): void {
  let borrowerOperations = BorrowerOperations.bind(event.address);
  let troveManagerAddress = borrowerOperations.troveManager();
  let troveManager = TroveManager.bind(troveManagerAddress);
  let snapshots = troveManager.rewardSnapshots(event.params._borrower);

  updateTrove(
    event,
    getTroveOperationFromBorrowerOperation(event.params.operation),
    event.params._borrower,
    event.params._coll,
    event.params._debt,
    event.params.stake,
    snapshots.value0,
    snapshots.value1
  );
}
