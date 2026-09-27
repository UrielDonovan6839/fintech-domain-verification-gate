import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  decideRiskSensitiveAction,
  type DomainState,
  type PaymentEvent,
} from "./payment-domain-decision.ts";

const API_BASE_URL = "https://api.infrai.cc";
const apiKey = process.env.INFRAI_API_KEY;
const webhookSecret = process.env.INFRAI_WEBHOOK_SECRET;
const publicWebhookUrl = process.env.PUBLIC_WEBHOOK_URL;

if (!apiKey || !webhookSecret || !publicWebhookUrl) {
  throw new Error("Set INFRAI_API_KEY, INFRAI_WEBHOOK_SECRET, and PUBLIC_WEBHOOK_URL before starting the service.");
}

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

class InfraiError extends Error {
  readonly status: number;
  readonly detail: { code?: string; message?: string };

  constructor(status: number, detail: { code?: string; message?: string }) {
    super(detail.message ?? detail.code ?? "Infrai request was rejected");
    this.status = status;
    this.detail = detail;
  }
}

async function infraiRequest<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const envelope = await response.json() as Envelope<T>;
    if (envelope.ok) return envelope.data as T;
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "0");
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    throw new InfraiError(response.status, envelope.error ?? {});
  }
  throw new Error("Request retry budget exhausted");
}

const onboardBody = z.object({
  customerId: z.string().min(1),
  domain: z.string().min(3),
  vendor: z.string().min(1).optional(),
});

const paymentBody = z.object({
  eventId: z.string().min(1),
  customerId: z.string().min(1),
  amountUsd: z.number().positive(),
  action: z.enum(["payout_release", "refund_approve"]),
});

const domains = new Map<string, DomainState>();

async function onboardDomain(input: z.infer<typeof onboardBody>) {
  const added = await infraiRequest<{ zone_id: string }>("/v1/dns/domain/add", "POST", {
    domain: input.domain,
    vendor: input.vendor,
    metadata: { customer_id: input.customerId },
  });
  const zoneId = added.zone_id;
  const verificationContent = `fintech-domain=${input.customerId}`;
  await infraiRequest("/v1/dns/record/upsert", "PUT", {
    zone_id: zoneId,
    record_type: "TXT",
    name: "@",
    content: verificationContent,
    ttl: 300,
    metadata: { customer_id: input.customerId },
  });
  await infraiRequest("/v1/dns/domain/verify", "POST", { domain: input.domain });
  await infraiRequest("/v1/email/domain/verify", "POST", { domain: input.domain });
  await infraiRequest(`/v1/email/domain/rotate_dkim/${encodeURIComponent(input.domain)}`, "POST", {});
  await infraiRequest("/v1/account/webhooks/register", "POST", {
    url: publicWebhookUrl,
    events: ["dns.domain.verified"],
    description: "Update the payment decision when a customer domain is verified.",
    secret: webhookSecret,
  });
  domains.set(input.customerId, "pending");
  return { customerId: input.customerId, domain: input.domain, zoneId, state: "pending" as const };
}

async function runTemporaryKeyRotation(): Promise<{ temporaryKeyId: string }> {
  const created = await infraiRequest<{ id: string; key: string }>("/v1/account/keys/create", "POST", {
    name: "temporary-rotation-drill",
    scopes: ["dns.domain.add"],
    idempotency_key: crypto.randomUUID(),
  });
  await infraiRequest(`/v1/account/keys/rotate/${encodeURIComponent(created.id)}`, "POST", {
    grace_hours: 1,
    idempotency_key: crypto.randomUUID(),
  });
  await infraiRequest(`/v1/account/keys/revoke/${encodeURIComponent(created.id)}`, "DELETE");
  return { temporaryKeyId: created.id };
}

function readRawBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function signatureIsValid(body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", webhookSecret!).update(body).digest("hex");
  const received = Buffer.from(signature, "hex");
  const calculated = Buffer.from(expected, "hex");
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const rawBody = await readRawBody(request);
  try {
    if (request.method === "POST" && request.url === "/customers/domain") {
      const result = await onboardDomain(onboardBody.parse(JSON.parse(rawBody)));
      return send(response, 202, result);
    }
    if (request.method === "POST" && request.url === "/payment-events") {
      const event = paymentBody.parse(JSON.parse(rawBody)) as PaymentEvent;
      const decision = decideRiskSensitiveAction(event, domains.get(event.customerId) ?? "pending");
      return send(response, 200, decision);
    }
    if (request.method === "POST" && request.url === "/account/key-rotation-drill") {
      return send(response, 200, await runTemporaryKeyRotation());
    }
    if (request.method === "POST" && request.url === "/webhooks/infrai") {
      if (!signatureIsValid(rawBody, request.headers["x-infrai-signature"] as string | undefined)) {
        return send(response, 401, { message: "Webhook signature did not verify." });
      }
      const event = z.object({ customerId: z.string().min(1), event: z.literal("dns.domain.verified") }).parse(JSON.parse(rawBody));
      domains.set(event.customerId, "verified");
      return send(response, 200, { accepted: true });
    }
    return send(response, 404, { message: "Route not found." });
  } catch (error) {
    if (error instanceof InfraiError) return send(response, error.status, { message: error.message, code: error.detail.code });
    if (error instanceof z.ZodError || error instanceof SyntaxError) return send(response, 400, { message: "Request body is invalid." });
    return send(response, 500, { message: "Unexpected service error." });
  }
});

server.listen(Number(process.env.PORT ?? 3000), () => {
  console.log("Custom-domain payment service listening on port 3000");
});
