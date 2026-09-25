// The wire envelope shared by the capability protocol and the client protocol: JSON-RPC 2.0,
// one message per frame, no batches. Requests carry an id and get exactly one response.
// Notifications carry no id and get none. Unknown fields anywhere are ignored, never rejected.

import { z } from "zod";

export const RpcId = z.union([z.string(), z.number().int()]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof RpcNotification>;

/** The `Error` entity from entities.md, as it travels inside a JSON-RPC error's `data`. */
export const ErrorCode = z.enum([
  "denied",
  "quota_exceeded",
  "unavailable",
  "not_found",
  "invalid",
  "timeout",
  "cancelled",
  "unsupported",
  "conflict",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolError = z.object({
  code: ErrorCode,
  message: z.string(),
  data: z.unknown().optional(),
  retryable: z.boolean(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

/** JSON-RPC numeric codes for each protocol error code. -32600..-32603 are the standard ones. */
export const RPC_ERROR_NUMBERS: Record<ErrorCode, number> = {
  invalid: -32602,
  unsupported: -32601,
  denied: -32001,
  quota_exceeded: -32002,
  unavailable: -32003,
  not_found: -32004,
  timeout: -32005,
  cancelled: -32006,
  conflict: -32007,
};

export const RpcErrorObject = z.object({
  code: z.number().int(),
  message: z.string(),
  data: ProtocolError.optional(),
});
export type RpcErrorObject = z.infer<typeof RpcErrorObject>;

export const RpcSuccess = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  result: z.unknown(),
});
export type RpcSuccess = z.infer<typeof RpcSuccess>;

export const RpcFailure = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId.nullable(),
  error: RpcErrorObject,
});
export type RpcFailure = z.infer<typeof RpcFailure>;

export const RpcResponse = z.union([RpcSuccess, RpcFailure]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const RpcMessage = z.union([RpcRequest, RpcNotification, RpcSuccess, RpcFailure]);
export type RpcMessage = z.infer<typeof RpcMessage>;

export function isRequest(m: RpcMessage): m is RpcRequest {
  return "method" in m && "id" in m;
}
export function isNotification(m: RpcMessage): m is RpcNotification {
  return "method" in m && !("id" in m);
}
export function isResponse(m: RpcMessage): m is RpcResponse {
  return !("method" in m);
}

export function request(id: RpcId, method: string, params?: unknown): RpcRequest {
  return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}
export function notification(method: string, params?: unknown): RpcNotification {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}
export function success(id: RpcId, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result };
}
export function failure(id: RpcId | null, error: ProtocolError): RpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: RPC_ERROR_NUMBERS[error.code], message: error.message, data: error },
  };
}

/** Builds a protocol error. `retryable` defaults per code. */
export function protocolError(code: ErrorCode, message: string, data?: unknown): ProtocolError {
  const retryable = code === "unavailable" || code === "timeout" || code === "quota_exceeded";
  return data === undefined ? { code, message, retryable } : { code, message, data, retryable };
}

/** Thrown inside a process to carry a protocol error to the wire. */
export class RpcError extends Error {
  readonly error: ProtocolError;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.error = protocolError(code, message, data);
  }
  get code(): ErrorCode {
    return this.error.code;
  }
}
