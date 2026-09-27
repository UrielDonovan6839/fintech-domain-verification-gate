export type PaymentEvent = {
  eventId: string;
  customerId: string;
  amountUsd: number;
  action: "payout_release" | "refund_approve";
};

export type DomainState = "pending" | "verified";

export type PaymentDecision = {
  action: "allow" | "hold";
  notification: string;
  audit: {
    eventId: string;
    customerId: string;
    reason: string;
  };
};

export function decideRiskSensitiveAction(
  event: PaymentEvent,
  domainState: DomainState,
): PaymentDecision {
  if (domainState === "verified") {
    return {
      action: "allow",
      notification: `Payment event ${event.eventId} is eligible for ${event.action}.`,
      audit: { eventId: event.eventId, customerId: event.customerId, reason: "custom domain verified" },
    };
  }

  return {
    action: "hold",
    notification: `Payment event ${event.eventId} remains held until the customer's domain is verified.`,
    audit: { eventId: event.eventId, customerId: event.customerId, reason: "custom domain verification pending" },
  };
}
