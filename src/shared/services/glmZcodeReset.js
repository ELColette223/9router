// Protected GLM Zcode reset consumption. /use is irreversible, so a write-ahead
// idempotency key is persisted BEFORE the call, reused on retries (server dedupes),
// and reconciled against /status history so a timeout-retry never double-consumes.
import { randomUUID } from "node:crypto";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import {
  ZcodeApiError,
  ZCODE_RESET_TYPES,
  fetchZcodeResetStatus,
  useZcodeReset,
} from "open-sse/services/usage/glmZcode.js";
import { GLM_ZCODE_CONFIG } from "@/shared/constants/config";

const SESSION_EXPIRED_MESSAGE = "ZCode session expired — re-login to the GLM connection to refresh your ZCode credentials.";
const UNCONFIRMED_MESSAGE = "ZCode reset use was not confirmed — retry to reconcile the pending attempt.";

function isAuthError(error) {
  return error instanceof ZcodeApiError && error.kind === "auth";
}

// Persist the write-ahead entry. Re-read before merging: updateProviderConnection
// replaces providerSpecificData wholesale, so the FULL merged object is passed.
async function persistPendingEntry(id, resetType, entry) {
  const fresh = await getProviderConnectionById(id);
  if (!fresh) return;
  const psd = fresh.providerSpecificData || {};
  await updateProviderConnection(id, {
    providerSpecificData: {
      ...psd,
      zcodeResetPending: { ...(psd.zcodeResetPending || {}), [resetType]: entry },
    },
  });
}

// Remove only this resetType's entry (keep the other type's); drop the
// zcodeResetPending object when empty. Optionally bump the opportunity epoch
// in the same write so a consumed reset does not immediately re-request grants.
async function clearPendingEntry(id, resetType, { bumpOpportunity = false } = {}) {
  const fresh = await getProviderConnectionById(id);
  if (!fresh) return;
  const psd = fresh.providerSpecificData || {};
  const pending = { ...(psd.zcodeResetPending || {}) };
  delete pending[resetType];

  const nextPsd = { ...psd };
  if (Object.keys(pending).length > 0) nextPsd.zcodeResetPending = pending;
  else delete nextPsd.zcodeResetPending;
  if (bumpOpportunity) {
    nextPsd.zcodeNextOpportunityAt = Math.max(
      psd.zcodeNextOpportunityAt ?? 0,
      Date.now() + GLM_ZCODE_CONFIG.resetOpportunityBumpMs,
    );
  }
  await updateProviderConnection(id, { providerSpecificData: nextPsd });
}

/**
 * Consume one ZCode reset opportunity with double-consumption protection.
 * → { ok:true, alreadyReset?:true } | { ok:false, uncertain?:true, message, status? }
 * Persisted state: providerSpecificData.zcodeResetPending[resetType] = { key, startedAt }.
 */
export async function useGlmResetProtected(connection, resetType, proxyOptions = null) {
  if (!ZCODE_RESET_TYPES.includes(resetType)) {
    return { ok: false, message: `Invalid ZCode reset type: ${resetType}` };
  }

  const id = connection.id;
  const psd = connection.providerSpecificData || {};
  const auth = {
    zcodeJwt: psd.zcodeJwtToken,
    businessToken: psd.zaiBusinessToken ?? null,
    proxyOptions,
  };

  let pending = psd.zcodeResetPending?.[resetType] ?? null;
  let key;

  if (pending) {
    // A prior attempt may have been consumed server-side despite a timeout.
    // Reconcile via history before spending another opportunity.
    let status;
    try {
      status = await fetchZcodeResetStatus(auth);
    } catch (error) {
      if (isAuthError(error)) {
        await clearPendingEntry(id, resetType);
        return { ok: false, status: 401, message: SESSION_EXPIRED_MESSAGE };
      }
      // Throttled/transport/unexpected: cannot reconcile → do NOT consume.
      // Keep pending; a later retry reconciles again.
      return { ok: false, uncertain: true, message: UNCONFIRMED_MESSAGE };
    }

    const latestUsedAt = resetType === "FIVE_HOUR" ? status.latestFiveHourUsedAt : status.latestWeekUsedAt;
    if (Number.isFinite(latestUsedAt) && latestUsedAt >= pending.startedAt) {
      await clearPendingEntry(id, resetType);
      return { ok: true, alreadyReset: true };
    }
    key = pending.key; // reuse — server dedupes by idempotency key
  } else {
    key = randomUUID();
    pending = { key, startedAt: Date.now() };
    await persistPendingEntry(id, resetType, pending); // write-ahead BEFORE /use
  }

  try {
    await useZcodeReset({ ...auth, resetType, idempotencyKey: key });
  } catch (error) {
    if (isAuthError(error)) {
      await clearPendingEntry(id, resetType);
      return { ok: false, status: 401, message: SESSION_EXPIRED_MESSAGE };
    }
    if (error instanceof ZcodeApiError && error.kind === "business") {
      await clearPendingEntry(id, resetType);
      return { ok: false, message: error.message };
    }
    // Throttled/transport/unexpected: keep pending; a retry reconciles or reuses the key.
    return { ok: false, uncertain: true, message: UNCONFIRMED_MESSAGE };
  }

  await clearPendingEntry(id, resetType, { bumpOpportunity: true });
  return { ok: true };
}
