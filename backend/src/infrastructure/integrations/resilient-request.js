"use strict";

const circuits = new Map();

function isTransient(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
  const code = String(error?.cause?.code || error?.code || "");
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error instanceof TypeError
    || /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|UND_ERR)/.test(code);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withExponentialBackoff(operation, {
  maxAttempts = Number(process.env.INTEGRATION_HTTP_MAX_ATTEMPTS) || 3,
  initialDelayMs = Number(process.env.INTEGRATION_HTTP_RETRY_INITIAL_MS) || 250,
  maxDelayMs = Number(process.env.INTEGRATION_HTTP_RETRY_MAX_MS) || 2_000,
} = {}) {
  const attempts = Math.max(1, Math.min(5, Math.floor(maxAttempts)));
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      const exponential = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)));
      const retryAfter = Math.max(0, Number(error.retryAfterMs) || 0);
      await delay(Math.min(maxDelayMs, retryAfter || Math.floor(Math.random() * (exponential + 1))));
    }
  }
}

async function withCircuitBreaker(key, operation, {
  failureThreshold = Number(process.env.INTEGRATION_CIRCUIT_FAILURE_THRESHOLD) || 5,
  resetTimeoutMs = Number(process.env.INTEGRATION_CIRCUIT_RESET_MS) || 30_000,
} = {}) {
  const now = Date.now();
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = { failures: 0, openedAt: 0, probeInFlight: false };
    circuits.set(key, circuit);
  }
  const isOpen = circuit.openedAt > 0;
  const halfOpen = isOpen && now - circuit.openedAt >= resetTimeoutMs;
  if (isOpen && !halfOpen) {
    const error = new Error(`Integration circuit is open for ${key}; retry after ${Math.ceil((resetTimeoutMs - (now - circuit.openedAt)) / 1000)} seconds`);
    error.code = "INTEGRATION_CIRCUIT_OPEN";
    error.retryAfterMs = Math.max(0, resetTimeoutMs - (now - circuit.openedAt));
    throw error;
  }
  if (halfOpen && circuit.probeInFlight) {
    const error = new Error(`Integration circuit is testing recovery for ${key}; retry shortly`);
    error.code = "INTEGRATION_CIRCUIT_HALF_OPEN";
    error.retryAfterMs = 1_000;
    throw error;
  }
  if (halfOpen) circuit.probeInFlight = true;

  try {
    const result = await operation();
    circuit.failures = 0;
    circuit.openedAt = 0;
    return result;
  } catch (error) {
    if (isTransient(error)) {
      circuit.failures += 1;
      if (halfOpen || circuit.failures >= Math.max(1, failureThreshold)) {
        circuit.openedAt = Date.now();
      }
    } else {
      // A provider validation/auth response proves the endpoint is reachable.
      circuit.failures = 0;
      circuit.openedAt = 0;
    }
    throw error;
  } finally {
    if (halfOpen) circuit.probeInFlight = false;
  }
}

function resilientRequest(key, operation, options) {
  // Retries happen inside the breaker so one exhausted logical request counts as
  // one provider failure; concurrent requests are rejected once it opens.
  return withCircuitBreaker(key, () => withExponentialBackoff(operation, options), options);
}

module.exports = { isTransient, withExponentialBackoff, withCircuitBreaker, resilientRequest };
