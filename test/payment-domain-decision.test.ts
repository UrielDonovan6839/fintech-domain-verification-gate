import assert from "node:assert/strict";
import test from "node:test";
import { decideRiskSensitiveAction } from "../src/payment-domain-decision.ts";

test("a pending custom domain holds payout release and records the reason", () => {
  const decision = decideRiskSensitiveAction(
    { eventId: "pay_42", customerId: "cust_7", amountUsd: 500, action: "payout_release" },
    "pending",
  );
  assert.equal(decision.action, "hold");
  assert.equal(decision.audit.reason, "custom domain verification pending");
});
