import { describe, before, it } from "mocha";
import chai, { expect, assert } from "chai";
import chaiAsPromised from "chai-as-promised";
import chaiSpies from "chai-spies";
import { BigNumber } from "@ethersproject/bignumber";
import { Signer } from "@ethersproject/abstract-signer";
import { ethers, network } from "@nomiclabs/buidler";

import { Decimal, Decimalish } from "@liquity/decimal";
import {
  Trove,
  StabilityDeposit,
  LiquityReceipt,
  SuccessfulReceipt,
  SentLiquityTransaction,
  ReadableLiquity,
  TroveChange,
  TroveAdjustment
} from "@liquity/lib-base";

import { deployAndSetupContracts } from "../utils/deploy";
import { HintHelpers } from "../types";
import { LiquityContracts, LiquityDeployment } from "../src/contracts";
import { PopulatableEthersLiquity, redeemMaxIterations } from "../src/PopulatableEthersLiquity";
import { EthersLiquity } from "../src/EthersLiquity";

const provider = ethers.provider;

chai.use(chaiAsPromised);
chai.use(chaiSpies);

function assertStrictEqual<T, U extends T>(
  actual: T,
  expected: U,
  message?: string
): asserts actual is U {
  assert.strictEqual(actual, expected, message);
}

const waitForSuccess = async <T extends LiquityReceipt>(
  tx: Promise<SentLiquityTransaction<unknown, T>>
) => {
  const receipt = await (await tx).waitForReceipt();
  assertStrictEqual(receipt.status, "succeeded" as const);

  return receipt as Extract<T, SuccessfulReceipt>;
};

const getAdjustment = <T>(change: TroveChange<T> | undefined): TroveAdjustment<T> => {
  assertStrictEqual(change?.type, "adjustment" as const);

  return change.params;
};

// TODO make the testcases isolated

describe("EthersLiquity", () => {
  let deployer: Signer;
  let funder: Signer;
  let user: Signer;
  let otherUsers: Signer[];

  let deployment: LiquityDeployment;

  let deployerLiquity: EthersLiquity;
  let liquity: EthersLiquity;
  let otherLiquities: EthersLiquity[];

  const connectUsers = (users: Signer[]) =>
    Promise.all(users.map(user => EthersLiquity.connect(deployment, user)));

  const openTroves = (users: Signer[], troves: Trove[]) =>
    troves
      .map((trove, i) => () =>
        Promise.all([
          EthersLiquity.connect(deployment, users[i]),
          sendTo(users[i], trove.collateral).then(tx => tx.wait())
        ]).then(([liquity]) => {
          liquity.openTrove(trove, {}, { gasPrice: 0 });
        })
      )
      .reduce((a, b) => a.then(b), Promise.resolve());

  const sendTo = (user: Signer, value: Decimalish, nonce?: number) =>
    funder.sendTransaction({
      to: user.getAddress(),
      value: Decimal.from(value).bigNumber,
      nonce
    });

  const sendToEach = async (users: Signer[], value: Decimalish) => {
    const txCount = await provider.getTransactionCount(funder.getAddress());
    const txs = await Promise.all(users.map((user, i) => sendTo(user, value, txCount + i)));

    // Wait for the last tx to be mined.
    await txs[txs.length - 1].wait();
  };

  before(async () => {
    [deployer, funder, user, ...otherUsers] = await ethers.getSigners();
    deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

    liquity = await EthersLiquity.connect(deployment, user);
    expect(liquity).to.be.an.instanceOf(EthersLiquity);
  });

  // Always setup same initial balance for user
  beforeEach(async () => {
    const targetBalance = Decimal.from(100).bigNumber;
    const balance = await user.getBalance();
    const gasPrice = 0;

    if (balance.eq(targetBalance)) {
      return;
    }

    if (balance.gt(targetBalance)) {
      await user.sendTransaction({
        to: funder.getAddress(),
        value: balance.sub(targetBalance),
        gasPrice
      });
    } else {
      await funder.sendTransaction({
        to: user.getAddress(),
        value: targetBalance.sub(balance),
        gasPrice
      });
    }

    expect(`${await user.getBalance()}`).to.equal(`${targetBalance}`);
  });

  it("should get the price", async () => {
    const price = await liquity.getPrice();
    expect(price).to.be.an.instanceOf(Decimal);
  });

  describe("findHintForCollateralRatio", () => {
    it("should pick the closest approx hint", async () => {
      type Resolved<T> = T extends Promise<infer U> ? U : never;
      type ApproxHint = Resolved<ReturnType<HintHelpers["getApproxHint"]>>;

      const fakeHints: ApproxHint[] = [
        { diff: BigNumber.from(3), hintAddress: "alice", latestRandomSeed: BigNumber.from(1111) },
        { diff: BigNumber.from(4), hintAddress: "bob", latestRandomSeed: BigNumber.from(2222) },
        { diff: BigNumber.from(1), hintAddress: "carol", latestRandomSeed: BigNumber.from(3333) },
        { diff: BigNumber.from(2), hintAddress: "dennis", latestRandomSeed: BigNumber.from(4444) }
      ];

      const fakeContracts = {
        borrowerOperations: {
          estimateAndPopulate: {
            openTrove: () => ({})
          }
        },

        hintHelpers: chai.spy.interface({
          getApproxHint: (..._args: any) => Promise.resolve(fakeHints.shift())
        }),

        sortedTroves: chai.spy.interface({
          findInsertPosition: (..._args: any) => Promise.resolve(["fake insert position"])
        })
      };

      const fakeLiquity = new PopulatableEthersLiquity(
        (fakeContracts as unknown) as LiquityContracts,
        (undefined as unknown) as ReadableLiquity,
        (undefined as unknown) as Signer
      );

      const collateralRatio = Decimal.from("1.5");
      const price = Decimal.from(200);

      const trove = new Trove({ collateral: 0.75, debt: 100 });
      expect(`${trove.collateralRatio(price)}`).to.equal(`${collateralRatio}`);

      await fakeLiquity.openTrove(trove, {
        numberOfTroves: 1000000, // 10 * sqrt(1M) / 2500 = 4 expected getApproxHint calls
        price
      });

      expect(fakeContracts.hintHelpers.getApproxHint).to.have.been.called.exactly(4);
      expect(fakeContracts.hintHelpers.getApproxHint).to.have.been.called.with(
        collateralRatio.bigNumber,
        price.bigNumber
      );

      // returned latestRandomSeed should be passed back on the next call
      expect(fakeContracts.hintHelpers.getApproxHint).to.have.been.called.with(BigNumber.from(1111));
      expect(fakeContracts.hintHelpers.getApproxHint).to.have.been.called.with(BigNumber.from(2222));
      expect(fakeContracts.hintHelpers.getApproxHint).to.have.been.called.with(BigNumber.from(3333));

      expect(fakeContracts.sortedTroves.findInsertPosition).to.have.been.called.once;
      expect(fakeContracts.sortedTroves.findInsertPosition).to.have.been.called.with(
        collateralRatio.bigNumber,
        price.bigNumber,
        "carol"
      );
    });
  });

  describe("Trove", () => {
    it("should have no Trove initially", async () => {
      const trove = await liquity.getTrove();

      expect(trove.isEmpty).to.be.true;
    });

    it("should fail to create an empty Trove", async () => {
      const emptyTrove = new Trove();

      await expect(liquity.openTrove(emptyTrove)).to.eventually.be.rejected;
    });

    it("should fail to create a Trove with too low ICR", async () => {
      const troveWithTooLowIcr = new Trove({ collateral: 0.05, debt: 10 });

      await expect(liquity.openTrove(troveWithTooLowIcr)).to.eventually.be.rejected;
    });

    it("should fail to create a Trove with only collateral", async () => {
      const troveWithOnlyCollateral = new Trove({ collateral: 1 });

      await expect(liquity.openTrove(troveWithOnlyCollateral)).to.eventually.be.rejected;
    });

    it("should fail to create a Trove with too little debt", async () => {
      const troveWithTooLittleDebt = new Trove({ collateral: 1, debt: 5 });

      await expect(liquity.openTrove(troveWithTooLittleDebt)).to.eventually.be.rejected;
    });

    it("should create a Trove with the minimum amount of debt", async () => {
      const troveWithMinimumAmountOfDebt = new Trove({ collateral: 1, debt: 10 });

      await liquity.openTrove(troveWithMinimumAmountOfDebt);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(troveWithMinimumAmountOfDebt);
    });

    it("should withdraw some of the collateral", async () => {
      const troveWithHalfOfTheCollateral = new Trove({ collateral: 0.5, debt: 10 });

      await liquity.withdrawCollateral(0.5);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(troveWithHalfOfTheCollateral);
    });

    it("should fail to close the Trove when there are no other Troves", async () => {
      const numberOfTroves = await liquity.getNumberOfTroves();
      expect(numberOfTroves).to.equal(1);

      expect(liquity.closeTrove()).to.eventually.be.rejected;
    });

    it("should close the Trove after another user creates a Trove", async () => {
      const funderLiquity = await EthersLiquity.connect(deployment, funder);
      await funderLiquity.openTrove(new Trove({ collateral: 1, debt: 10 }));

      await liquity.closeTrove();
      const trove = await liquity.getTrove();

      expect(trove.isEmpty).to.be.true;
    });

    it("should create a Trove with some more debt", async () => {
      const troveWithSomeDebt = new Trove({ collateral: 1, debt: 100 });

      await liquity.openTrove(troveWithSomeDebt);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(troveWithSomeDebt);
    });

    it("should fail to withdraw all the collateral while the Trove has debt", async () => {
      const trove = await liquity.getTrove();

      await expect(liquity.withdrawCollateral(trove.collateral)).to.eventually.be.rejected;
    });

    it("should repay some debt", async () => {
      await liquity.repayLUSD(10);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(new Trove({ collateral: 1, debt: 90 }));
    });

    it("should borrow some more", async () => {
      await liquity.borrowLUSD(20);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(new Trove({ collateral: 1, debt: 110 }));
    });

    it("should deposit more collateral", async () => {
      await liquity.depositCollateral(1);
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(new Trove({ collateral: 2, debt: 110 }));
    });

    it("should repay some debt and withdraw some collateral at the same time", async () => {
      await liquity.adjustTrove({ repayLUSD: 60, withdrawCollateral: 0.5 }, undefined, {
        gasPrice: 0
      });

      const trove = await liquity.getTrove();
      expect(trove).to.deep.equal(new Trove({ collateral: 1.5, debt: 50 }));

      const ethBalance = new Decimal(await user.getBalance());
      expect(`${ethBalance}`).to.equal("100.5");
    });

    it("should borrow more and deposit some collateral at the same time", async () => {
      await liquity.adjustTrove({ borrowLUSD: 60, depositCollateral: 0.5 }, undefined, {
        gasPrice: 0
      });

      const trove = await liquity.getTrove();
      expect(trove).to.deep.equal(new Trove({ collateral: 2, debt: 110 }));

      const ethBalance = new Decimal(await user.getBalance());
      expect(`${ethBalance}`).to.equal("99.5");
    });
  });

  describe("SendableEthersLiquity", () => {
    it("should parse failed transactions without throwing", async () => {
      const invalidTrove = new Trove({ debt: 10 });
      const ampleGas = BigNumber.from(10).pow(6);

      // By passing a gasLimit, we avoid automatic use of estimateGas which would throw
      const tx = await liquity.send.openTrove(invalidTrove, undefined, { gasLimit: ampleGas });
      const { status } = await tx.waitForReceipt();

      expect(status).to.equal("failed");
    });
  });

  describe("StabilityPool", () => {
    before(async () => {
      deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

      [deployerLiquity, liquity, ...otherLiquities] = await connectUsers([
        deployer,
        user,
        ...otherUsers.slice(0, 1)
      ]);

      await funder.sendTransaction({
        to: otherUsers[0].getAddress(),
        value: Decimal.from(0.23).bigNumber
      });
    });

    it("should make a small stability deposit", async () => {
      await liquity.openTrove(new Trove({ collateral: 1, debt: 100 }));
      await liquity.depositLUSDInStabilityPool(10);
    });

    it("other user should make a Trove with very low ICR", async () => {
      await otherLiquities[0].openTrove(new Trove({ collateral: 0.2233, debt: 39 }));
      const otherTrove = await otherLiquities[0].getTrove();
      const price = await liquity.getPrice();

      expect(`${otherTrove.collateralRatio(price)}`).to.equal("1.145128205128205128");
    });

    it("the price should take a dip", async () => {
      await deployerLiquity.setPrice(190);
      const price = await liquity.getPrice();

      expect(`${price}`).to.equal("190");
    });

    it("should liquidate other user's Trove", async () => {
      const details = await liquity.liquidateUpTo(1);

      expect(details).to.deep.equal({
        fullyLiquidated: [await otherUsers[0].getAddress()],
        partiallyLiquidated: undefined,

        collateralGasCompensation: Decimal.from(0.0011165), // 0.5%
        lusdGasCompensation: Decimal.from(10),

        totalLiquidated: new Trove({
          collateral: Decimal.from(0.2221835), // -0.5%
          debt: Decimal.from(39)
        })
      });

      const otherTrove = await otherLiquities[0].getTrove();
      expect(otherTrove.isEmpty).to.be.true;
    });

    it("should have a depleted stability deposit and some collateral gain", async () => {
      const deposit = await liquity.getStabilityDeposit();

      expect(deposit).to.deep.equal(
        new StabilityDeposit({
          deposit: 10,
          depositAfterLoss: 0,
          pendingCollateralGain: "0.0569701282051282" // multiplied by 0.995
        })
      );
    });

    it("should have some pending rewards in the Trove", async () => {
      const trove = await liquity.getTrove();

      expect(trove).to.deep.equal(
        new Trove({
          collateral: "1.165213371794871795",
          debt: 129
        })
      );
    });

    it("total should equal the Trove", async () => {
      const trove = await liquity.getTrove();

      const numberOfTroves = await liquity.getNumberOfTroves();
      expect(numberOfTroves).to.equal(1);

      const total = await liquity.getTotal();
      expect(total.equals(trove)).to.be.true;
    });

    it("should transfer the gains to the Trove", async () => {
      await liquity.transferCollateralGainToTrove();
      const trove = await liquity.getTrove();
      const deposit = await liquity.getStabilityDeposit();

      expect(trove).to.deep.equal(
        new Trove({
          collateral: "1.222183499999999995", // ~ 1 + 0.2233 * 0.995
          debt: 129
        })
      );

      expect(deposit.isEmpty).to.be.true;
    });

    describe("when non-empty in recovery mode", () => {
      before(async () => {
        // Deploy new instances of the contracts, for a clean slate
        deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

        const otherUsersSubset = otherUsers.slice(0, 2);
        [deployerLiquity, liquity, ...otherLiquities] = await connectUsers([
          deployer,
          user,
          ...otherUsersSubset
        ]);

        await sendToEach(otherUsersSubset, 1.1);

        let price = Decimal.from(200);
        await deployerLiquity.setPrice(price);

        await otherLiquities[0].openTrove(new Trove({ collateral: 1, debt: 100 }));
        await otherLiquities[1].openTrove(new Trove({ collateral: 1, debt: 100 }));

        await liquity.openTrove(new Trove({ collateral: 10.075, debt: 1410 }));
        await liquity.depositLUSDInStabilityPool(100);

        price = Decimal.from(190);
        await deployerLiquity.setPrice(price);

        const total = await deployerLiquity.getTotal();
        expect(total.collateralRatio(price).lt(1.5)).to.be.true;
      });

      it("should partially liquidate the bottom Trove", async () => {
        await liquity.liquidateUpTo(40);

        const trove = await liquity.getTrove();
        // 10.075 * 1310 / 1410
        expect(trove).to.deep.equal(new Trove({ collateral: "9.360460992907801419", debt: 1310 }));
      });

      describe("after depositing some more tokens", () => {
        before(async () => {
          await liquity.depositLUSDInStabilityPool(1300);
          await otherLiquities[0].depositLUSDInStabilityPool(10);
        });

        it("should liquidate more of the bottom Trove", async () => {
          await liquity.liquidateUpTo(40);

          const trove = await liquity.getTrove();
          expect(trove.isEmpty).to.be.true;
        });
      });
    });

    describe("when people overstay", () => {
      before(async () => {
        // Deploy new instances of the contracts, for a clean slate
        deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

        const otherUsersSubset = otherUsers.slice(0, 5);
        [deployerLiquity, liquity, ...otherLiquities] = await connectUsers([
          deployer,
          user,
          ...otherUsersSubset
        ]);

        await sendToEach(otherUsersSubset, 2.1);

        let price = Decimal.from(200);
        await deployerLiquity.setPrice(price);

        // Use this account to print QUI
        await liquity.openTrove(new Trove({ collateral: 10, debt: 510 }));

        // otherLiquities[0-2] will be independent stability depositors
        await liquity.sendLUSD(await otherUsers[0].getAddress(), 300);
        await liquity.sendLUSD(await otherUsers[1].getAddress(), 100);
        await liquity.sendLUSD(await otherUsers[2].getAddress(), 100);

        // otherLiquities[3-4] will be Trove owners whose Troves get liquidated
        await otherLiquities[3].openTrove(new Trove({ collateral: 2, debt: 300 }));
        await otherLiquities[4].openTrove(new Trove({ collateral: 2, debt: 300 }));

        await otherLiquities[0].depositLUSDInStabilityPool(300);
        await otherLiquities[1].depositLUSDInStabilityPool(100);
        // otherLiquities[2] doesn't deposit yet

        // Tank the price so we can liquidate
        price = Decimal.from(150);
        await deployerLiquity.setPrice(price);

        // Liquidate first victim
        await liquity.liquidate(await otherUsers[3].getAddress());
        expect((await otherLiquities[3].getTrove()).isEmpty).to.be.true;

        // Now otherLiquities[2] makes their deposit too
        await otherLiquities[2].depositLUSDInStabilityPool(100);

        // Liquidate second victim
        await liquity.liquidate(await otherUsers[4].getAddress());
        expect((await otherLiquities[4].getTrove()).isEmpty).to.be.true;

        // Stability Pool is now empty
        expect(`${await liquity.getLUSDInStabilityPool()}`).to.equal("0");
      });

      it("should still be able to withdraw remaining deposit", async () => {
        for (const l of [otherLiquities[0], otherLiquities[1], otherLiquities[2]]) {
          const stabilityDeposit = await l.getStabilityDeposit();
          await l.withdrawLUSDFromStabilityPool(stabilityDeposit.depositAfterLoss);
        }
      });
    });
  });

  describe("Redemption", () => {
    before(async () => {
      // Deploy new instances of the contracts, for a clean slate
      deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

      const otherUsersSubset = otherUsers.slice(0, 3);
      [deployerLiquity, liquity, ...otherLiquities] = await connectUsers([
        deployer,
        user,
        ...otherUsersSubset
      ]);

      await sendToEach(otherUsersSubset, 1.1);

      await liquity.openTrove(new Trove({ collateral: 20, debt: 110 }));
      await otherLiquities[0].openTrove(new Trove({ collateral: 1, debt: 20 }));
      await otherLiquities[1].openTrove(new Trove({ collateral: 1, debt: 30 }));
      await otherLiquities[2].openTrove(new Trove({ collateral: 1, debt: 40 }));
    });

    // it("should find hints for redemption", async () => {
    //   const redemptionHints = await liquity._findRedemptionHints(Decimal.from(55));

    //   // 30 would be redeemed from otherLiquities[2],
    //   // 20 from otherLiquities[1],
    //   // 5 from otherLiquities[0] (as there are 10 for gas compensation in each)
    //   expect(redemptionHints).to.deep.equal([
    //     await otherUsers[2].getAddress(),
    //     await user.getAddress(),
    //     Decimal.from("13")
    //     // (1 ETH * 200 - 5) / (20 - 5) = 13
    //     // (subtracting 5 for the redemption to otherLiquities[0])
    //   ]);
    // });

    it("should redeem some collateral", async () => {
      const details = await liquity.redeemLUSD(55, {}, { gasPrice: 0 });

      expect(details).to.deep.equal({
        attemptedLUSDAmount: Decimal.from(55),
        actualLUSDAmount: Decimal.from(55),
        collateralReceived: Decimal.from(0.275),
        // fee: Decimal.from("0.084027777777777777")
        fee: Decimal.from("0.042013888888888888")
      });

      const balance = new Decimal(await provider.getBalance(user.getAddress()));
      expect(`${balance}`).to.equal("100.232986111111111112");

      expect(`${await liquity.getLUSDBalance()}`).to.equal("45");

      expect(`${(await otherLiquities[0].getTrove()).debt}`).to.equal("15");
      expect((await otherLiquities[1].getTrove()).isEmpty).to.be.true;
      expect((await otherLiquities[2].getTrove()).isEmpty).to.be.true;
    });
  });

  describe("Redemption, gas checks", function () {
    this.timeout("5m");

    before(async function () {
      if (network.name === "dev") {
        // Only about the first 40 accounts work when testing on the dev chain due to a not yet
        // known issue.

        // Since this test needs more than that, let's skip it on dev for now.
        this.skip();
      }

      // Deploy new instances of the contracts, for a clean slate
      deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);
      const otherUsersSubset = otherUsers.slice(0, redeemMaxIterations);
      expect(otherUsersSubset).to.have.length(redeemMaxIterations);

      [deployerLiquity, liquity, ...otherLiquities] = await connectUsers([
        deployer,
        user,
        ...otherUsersSubset
      ]);

      await sendToEach(otherUsersSubset, 1.1);

      await liquity.openTrove(new Trove({ collateral: 50, debt: 410 }));
      for (let otherLiquity of otherLiquities) {
        await otherLiquity.openTrove(new Trove({ collateral: 1, debt: 11 }));
      }
    });

    it("should redeem using the maximum iterations and almost all gas", async () => {
      const { rawReceipt } = await waitForSuccess(liquity.send.redeemLUSD(redeemMaxIterations));

      const gasUsed = rawReceipt.gasUsed.toNumber();
      // gasUsed is ~half the real used amount because of how refunds work, see:
      // https://ethereum.stackexchange.com/a/859/9205
      expect(gasUsed).to.be.at.least(4950000, "should use close to 10M gas");
    });
  });

  describe("Gas estimation", () => {
    const increaseTime = (timeJump: number) => provider.send("evm_increaseTime", [timeJump]);
    const troveWithICRBetween = (a: Trove, b: Trove) => a.add(b).multiply(0.5);

    let rudeUser: Signer;
    let fiveOtherUsers: Signer[];
    let rudeLiquity: EthersLiquity;

    before(async function () {
      if (network.name !== "buidlerevm") {
        this.skip();
      }

      deployment = await deployAndSetupContracts(deployer, ethers.getContractFactory);

      [rudeUser, ...fiveOtherUsers] = otherUsers.slice(0, 6);

      [deployerLiquity, liquity, rudeLiquity, ...otherLiquities] = await connectUsers([
        deployer,
        user,
        rudeUser,
        ...fiveOtherUsers
      ]);

      await openTroves(fiveOtherUsers, [
        new Trove({ collateral: 1, debt: 50 }),
        new Trove({ collateral: 1, debt: 60 }),
        new Trove({ collateral: 1, debt: 70 }),
        new Trove({ collateral: 1, debt: 80 }),
        new Trove({ collateral: 1, debt: 90 })
      ]);
    });

    it("should include enough gas for updating lastFeeOperationTime", async () => {
      await liquity.openTrove(new Trove({ collateral: 1, debt: 100 }));

      // We just updated lastFeeOperationTime, so this won't anticipate having to update that
      // during estimateGas
      const tx = await liquity.populate.redeemLUSD(1);
      const originalGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);

      // Fast-forward 2 minutes.
      await increaseTime(120);

      // Required gas has just went up.
      const newGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);
      const gasIncrease = newGasEstimate.sub(originalGasEstimate).toNumber();
      expect(gasIncrease).to.be.within(5000, 10000);

      // This will now have to update lastFeeOperationTime
      await waitForSuccess(tx.send());

      // Decay base-rate back to 0
      await increaseTime(100000000);
    });

    it("should include enough gas for one extra traversal", async () => {
      const troves = (await liquity.getLastTroves(0, 10)).map(([, t]) => t);

      const trove = await liquity.getTrove();
      const newTrove = troveWithICRBetween(troves[3], troves[4]);

      // First, we want to test a non-borrowing case, to make sure we're not passing due to any
      // extra gas we add to cover a potential lastFeeOperationTime update
      const adjustment = getAdjustment(trove.whatChanged(newTrove));
      expect(adjustment.borrowLUSD).to.be.undefined;

      const tx = await liquity.populate.adjustTrove(adjustment);
      const originalGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);

      // A terribly rude user interferes
      await openTroves([rudeUser], [newTrove.addDebt(1)]);

      const newGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);
      const gasIncrease = newGasEstimate.sub(originalGasEstimate).toNumber();

      await waitForSuccess(tx.send());
      expect(gasIncrease).to.be.within(10000, 15000);

      await rudeLiquity.closeTrove({ gasPrice: 0 });
    });

    it("should include enough gas for both when borrowing", async () => {
      const troves = (await liquity.getLastTroves(0, 10)).map(([, t]) => t);
      const trove = await liquity.getTrove();
      const newTrove = troveWithICRBetween(troves[1], troves[2]);

      // Make sure we're borrowing
      const adjustment = getAdjustment(trove.whatChanged(newTrove));
      expect(adjustment.borrowLUSD).to.not.be.undefined;

      const tx = await liquity.populate.adjustTrove(adjustment);
      const originalGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);

      // A terribly rude user interferes again
      await openTroves([rudeUser], [newTrove.addDebt(1)]);

      // On top of that, we'll need to update lastFeeOperationTime
      await increaseTime(120);

      const newGasEstimate = await provider.estimateGas(tx.rawPopulatedTransaction);
      const gasIncrease = newGasEstimate.sub(originalGasEstimate).toNumber();

      await waitForSuccess(tx.send());
      expect(gasIncrease).to.be.within(15000, 25000);
    });
  });
});
