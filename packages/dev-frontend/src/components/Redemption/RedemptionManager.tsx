import React, { useState } from "react";
import { Button, Box, Flex, Card, Heading } from "theme-ui";

import { Decimal, Percent, LiquityStoreState, MINIMUM_COLLATERAL_RATIO } from "@liquity/lib-base";
import { useLiquitySelector } from "@liquity/lib-react";

import { COIN } from "../../strings";

import { Icon } from "../Icon";
import { LoadingOverlay } from "../LoadingOverlay";
import { EditableRow, StaticRow } from "../Trove/Editor";
import { ActionDescription, Amount } from "../ActionDescription";

import { RedemptionAction } from "./RedemptionAction";
import { ErrorDescription } from "../ErrorDescription";

const mcrPercent = new Percent(MINIMUM_COLLATERAL_RATIO).toString(0);

const select = ({ price, fees, total, lusdBalance }: LiquityStoreState) => ({
  price,
  fees,
  total,
  lusdBalance
});

export const RedemptionManager: React.FC = () => {
  const { price, fees, total, lusdBalance } = useLiquitySelector(select);
  const [lusdAmount, setLUSDAmount] = useState(Decimal.ZERO);
  const [changePending, setChangePending] = useState(false);
  const editingState = useState<string>();

  const dirty = !lusdAmount.isZero;
  const ethAmount = lusdAmount.div(price);
  const redemptionRate = fees.redemptionRate(lusdAmount.div(total.debt));
  const feePct = new Percent(redemptionRate);
  const ethFee = ethAmount.mul(redemptionRate);
  const maxRedemptionRate = redemptionRate.add(0.001); // TODO slippage tolerance

  const [canRedeem, description] = total.collateralRatioIsBelowMinimum(price)
    ? [
        false,
        <ErrorDescription>
          You can't redeem LUSD when the total collateral ratio is less than{" "}
          <Amount>{mcrPercent}</Amount>. Please try again later.
        </ErrorDescription>
      ]
    : lusdAmount.gt(lusdBalance)
    ? [
        false,
        <ErrorDescription>
          The amount you're trying to redeem exceeds your balance by{" "}
          <Amount>
            {lusdAmount.sub(lusdBalance).prettify()} {COIN}
          </Amount>
          .
        </ErrorDescription>
      ]
    : [
        true,
        <ActionDescription>
          You will receive <Amount>{ethAmount.sub(ethFee).prettify(4)} ETH</Amount> in exchange for{" "}
          <Amount>
            {lusdAmount.prettify()} {COIN}
          </Amount>
          .
        </ActionDescription>
      ];

  return (
    <>
      <Card>
        <Heading>
          Redemption
          {dirty && !changePending && (
            <Button
              variant="titleIcon"
              sx={{ ":enabled:hover": { color: "danger" } }}
              onClick={() => setLUSDAmount(Decimal.ZERO)}
            >
              <Icon name="history" size="lg" />
            </Button>
          )}
        </Heading>

        <Box sx={{ p: [2, 3] }}>
          <EditableRow
            label="Redeem"
            inputId="redeem-lusd"
            amount={lusdAmount.prettify()}
            maxAmount={lusdBalance.toString()}
            maxedOut={lusdAmount.eq(lusdBalance)}
            unit={COIN}
            {...{ editingState }}
            editedAmount={lusdAmount.toString(2)}
            setEditedAmount={amount => setLUSDAmount(Decimal.from(amount))}
          />

          {dirty && (
            <StaticRow
              label="Fee"
              inputId="redeem-fee"
              amount={ethFee.toString(4)}
              pendingAmount={feePct.toString(2)}
              unit="ETH"
            />
          )}

          {((dirty || !canRedeem) && description) || (
            <ActionDescription>Enter the amount of {COIN} you'd like to redeem.</ActionDescription>
          )}

          <Flex variant="layout.actions">
            <RedemptionAction
              disabled={!dirty || !canRedeem}
              {...{ lusdAmount, setLUSDAmount, changePending, setChangePending, maxRedemptionRate }}
            />
          </Flex>
        </Box>

        {changePending && <LoadingOverlay />}
      </Card>
    </>
  );
};
